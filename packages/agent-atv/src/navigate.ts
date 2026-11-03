import { devicePath } from './client.js';
import type { Context } from './context.js';
import { AtvError } from './errors.js';
import { formatFocus, formatFocusLine, type FocusElement, type FocusReport, type Unavailable } from './output.js';

export const ARROWS = ['up', 'down', 'left', 'right'] as const;
export type Arrow = (typeof ARROWS)[number];

export const isArrow = (key: string): key is Arrow => (ARROWS as readonly string[]).includes(key);

const OPPOSITE: Record<Arrow, Arrow> = { up: 'down', down: 'up', left: 'right', right: 'left' };
const crossAxis = (arrow: Arrow): Arrow => (arrow === 'up' || arrow === 'down' ? 'right' : 'down');

/** `unknown`: the focus could not be read after a press, so the next presses would be blind. */
export type Stop = 'found' | 'no_move' | 'repeat' | 'max' | 'unknown';

export interface Walk {
  stop: Stop;
  presses: number;
  /** The focused element before the first press, when the plugin knew it. */
  start: FocusElement | null;
  /** The element each press moved the focus to, in order. */
  passed: FocusElement[];
  focus: FocusElement | null;
  /** Why the focus could not be read, for `unknown`. */
  lost?: Unavailable;
}

/** Sends one arrow and returns the settled focus the plugin reports after it. */
export type PressArrow = (arrow: Arrow) => Promise<FocusReport | undefined>;

const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function matches(element: FocusElement, text: string): boolean {
  const needle = fold(text);
  return [element.label, element.value, element.identifier].some((field) => field !== null && fold(field).includes(needle));
}

const same = (a: FocusElement, b: FocusElement): boolean =>
  a.label === b.label && a.value === b.value && a.identifier === b.identifier;

/** The focused element now, or null when the plugin does not know it (a cold read, not followed). */
export async function currentFocus(ctx: Context): Promise<FocusElement | null> {
  try {
    const { focus } = await ctx.client().json<{ focus: FocusElement }>('GET', devicePath(ctx.device(), '/focus'));
    return focus;
  } catch (error) {
    if (error instanceof AtvError) return null;
    throw error;
  }
}

/** A plugin that did not say whether the key moved the focus (its follow failed, or it predates `moved`). */
const NO_MOVED: Unavailable = {
  available: false,
  code: 'SCREEN_UNAVAILABLE',
  reason: 'the plugin did not say whether the key moved the focus',
  hint: 'retry in a few seconds; if it keeps happening, update homebridge-agent-atv in the Homebridge UI (Plugins)',
};

/**
 * Presses `arrow` one key at a time, reading where each press moved the focus, until the focus
 * matches `until`, a press moves nothing, the focus reaches an element already seen, the focus
 * cannot be read, or `max` presses.
 */
export async function walk(press: PressArrow, arrow: Arrow, start: FocusElement | null, max: number, until?: string): Promise<Walk> {
  const passed: FocusElement[] = [];
  let presses = 0;
  const result = (stop: Stop, focus: FocusElement | null, lost?: Unavailable): Walk => ({
    stop, presses, start, passed, focus, ...(lost ? { lost } : {}),
  });
  if (until !== undefined && start && matches(start, until)) return result('found', start);
  while (presses < max) {
    const report = await press(arrow);
    presses += 1;
    if (!report?.available) return result('unknown', passed.at(-1) ?? start, report ?? NO_MOVED);
    if (report.moved === undefined) return result('unknown', passed.at(-1) ?? start, NO_MOVED);
    const { element } = report;
    if (!report.moved) return result('no_move', element);
    if ((start && same(start, element)) || passed.some((seen) => same(seen, element))) return result('repeat', element);
    passed.push(element);
    if (until !== undefined && matches(element, until)) return result('found', element);
  }
  return result('max', passed.at(-1) ?? start);
}

const NO_MOVE = 'no move reported (the end of the row, or a screen that does not report moves)';

function stopReason(w: Walk): string {
  switch (w.stop) {
    case 'no_move':
      return `${NO_MOVE} after press ${w.presses}`;
    case 'repeat':
      return `press ${w.presses} reached ${formatFocus(w.focus)} again (a row that wraps around, or two tiles that read the same)`;
    case 'max':
      return `stopped after --max ${w.presses} presses`;
    default:
      return `${w.lost!.reason} after press ${w.presses}`;
  }
}

/** `0 <start>`, then one numbered line per element passed; the focused one is marked. */
export function walkLines(w: Walk): string[] {
  const elements = [...(w.start ? [w.start] : []), ...w.passed];
  const offset = w.start ? 0 : 1;
  const focused = w.focus ? elements.findIndex((element) => same(element, w.focus!)) : -1;
  return elements.map((element, i) => `${i + offset} ${formatFocus(element)}${i === focused ? '  <- focus' : ''}`);
}

const walkBody = (w: Walk) => ({ presses: w.presses, start: w.start, passed: w.passed, focus: w.focus });

function printWalk(ctx: Context, headline: string, w: Walk): void {
  ctx.print(headline);
  for (const line of walkLines(w)) ctx.print(line);
}

/** A focus lost on the way: what was passed so far, then the focus error with its own fix. */
function failLost(ctx: Context, w: Walk, headline: string): never {
  if (!ctx.json) printWalk(ctx, headline, w);
  throw new AtvError(w.lost!.code, `Stopped: ${stopReason(w)}`, { hint: w.lost!.hint, details: { stop: w.stop, ...walkBody(w) } });
}

export function printUntil(ctx: Context, w: Walk, arrow: Arrow, until: string, max: number): void {
  const quoted = JSON.stringify(until);
  if (w.stop === 'found') {
    if (ctx.json) return ctx.printJson({ found: true, ...walkBody(w) });
    ctx.print(w.presses === 0 ? `pressed nothing: the focus already matches ${quoted}` : `pressed ${arrow}*${w.presses} until ${quoted}`);
    ctx.print(formatFocusLine({ available: true, element: w.focus! }));
    return;
  }
  const headline = `pressed ${arrow}*${w.presses}: ${quoted} not found`;
  if (w.stop === 'unknown') failLost(ctx, w, headline);
  if (!ctx.json) printWalk(ctx, headline, w);
  const otherRow = `agent-atv press ${crossAxis(arrow)} --settle`;
  const look = 'agent-atv screenshot --max-width 1280 --jpeg';
  const hints = {
    no_move: `look the other way (agent-atv press ${OPPOSITE[arrow]} --until ${quoted}) or in another row (${otherRow}); to check the row really ends: ${look}`,
    repeat: `it is not in this row: try another row (${otherRow}), or look with ${look}`,
    max: `go on with agent-atv press ${arrow} --until ${quoted} --max ${max * 2}`,
  };
  throw new AtvError('FOCUS_NOT_FOUND', `${quoted} not found pressing ${arrow}: ${stopReason(w)}`, {
    hint: hints[w.stop as keyof typeof hints],
    details: { stop: w.stop, ...walkBody(w) },
  });
}

export function printScan(ctx: Context, w: Walk, arrow: Arrow): void {
  const headline = `scanned ${arrow}: ${w.passed.length} moves, then ${stopReason(w)}`;
  if (w.stop === 'unknown') failLost(ctx, w, headline);
  if (ctx.json) return ctx.printJson({ stop: w.stop, ...walkBody(w) });
  printWalk(ctx, w.stop === 'max' ? `${headline}; more may follow: agent-atv press ${arrow} --scan --max ${w.presses * 2}` : headline, w);
}
