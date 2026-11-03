import { devicePath } from './client.js';
import type { Context } from './context.js';
import { AtvError } from './errors.js';
import { formatFocus, formatFocusLine, type FocusElement, type FocusReport } from './output.js';

export const ARROWS = ['up', 'down', 'left', 'right'] as const;
export type Arrow = (typeof ARROWS)[number];

const OPPOSITE: Record<Arrow, Arrow> = { up: 'down', down: 'up', left: 'right', right: 'left' };

export type Stop = 'found' | 'no_move' | 'repeat' | 'max';

export interface Walk {
  stop: Stop;
  presses: number;
  /** The focused element before the first press, when the plugin knew it. */
  start: FocusElement | null;
  /** The element each press moved the focus to, in order. */
  passed: FocusElement[];
  focus: FocusElement | null;
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

/**
 * Presses `arrow` one key at a time, reading where each press moved the focus, until the focus
 * matches `until`, a press moves nothing, the focus comes back to an element already passed, or
 * `max` presses. A focus that cannot be read stops it at once: the presses would be blind.
 */
export async function walk(press: PressArrow, arrow: Arrow, start: FocusElement | null, max: number, until?: string): Promise<Walk> {
  const passed: FocusElement[] = [];
  let presses = 0;
  const result = (stop: Stop, focus: FocusElement | null): Walk => ({ stop, presses, start, passed, focus });
  if (until !== undefined && start && matches(start, until)) return result('found', start);
  while (presses < max) {
    const report = await press(arrow);
    presses += 1;
    if (!report?.available) throw focusLost(report, presses);
    const { element } = report;
    if (report.moved === false) return result('no_move', element);
    if ((start && same(start, element)) || passed.some((seen) => same(seen, element))) return result('repeat', element);
    passed.push(element);
    if (until !== undefined && matches(element, until)) return result('found', element);
  }
  return result('max', passed.at(-1) ?? start);
}

function focusLost(report: FocusReport | undefined, press: number): AtvError {
  if (!report) {
    return new AtvError('FOCUS_UNKNOWN', `The plugin reported no focus after press ${press}`, {
      hint: 'update the homebridge-agent-atv plugin, then retry',
    });
  }
  const unavailable = report as Exclude<FocusReport, { available: true }>;
  return new AtvError(unavailable.code, `Stopped after press ${press}: ${unavailable.reason}`, { hint: unavailable.hint });
}

const STOPS: Record<Exclude<Stop, 'found'>, (walk: Walk) => string> = {
  no_move: (w) => `no move reported after press ${w.presses} (the end of the row, or a screen that does not report moves)`,
  repeat: (w) => `the focus came back to ${formatFocus(w.focus)} after press ${w.presses}: the row wraps around`,
  max: (w) => `stopped after --max ${w.presses} presses`,
};

/** `0 <start>`, then one numbered line per element passed; the focused one is marked. */
export function walkLines(w: Walk): string[] {
  const elements = [...(w.start ? [w.start] : []), ...w.passed];
  const offset = w.start ? 0 : 1;
  const focused = w.focus ? elements.findIndex((element) => same(element, w.focus!)) : -1;
  return elements.map((element, i) => `${i + offset} ${formatFocus(element)}${i === focused ? '  <- focus' : ''}`);
}

export function printUntil(ctx: Context, w: Walk, arrow: Arrow, until: string, max: number): void {
  const body = { presses: w.presses, start: w.start, passed: w.passed, focus: w.focus };
  if (w.stop === 'found') {
    if (ctx.json) return ctx.printJson({ found: true, ...body });
    ctx.print(w.presses === 0 ? `pressed nothing: the focus already matches ${JSON.stringify(until)}` : `pressed ${arrow}*${w.presses} until ${JSON.stringify(until)}`);
    ctx.print(formatFocusLine({ available: true, element: w.focus! }));
    return;
  }
  if (!ctx.json) {
    ctx.print(`pressed ${arrow}*${w.presses}: ${JSON.stringify(until)} not found`);
    for (const line of walkLines(w)) ctx.print(line);
  }
  const quoted = JSON.stringify(until);
  const hints: Record<Exclude<Stop, 'found'>, string> = {
    no_move: `look the other way (agent-atv press ${OPPOSITE[arrow]} --until ${quoted}) or in another row (agent-atv press ${arrow === 'up' || arrow === 'down' ? 'right' : 'down'} --settle); to check the row really ends: agent-atv screenshot --max-width 1280 --jpeg`,
    repeat: `it is not in this row: try another row (agent-atv press ${arrow === 'up' || arrow === 'down' ? 'right' : 'down'} --settle), or look with agent-atv screenshot --max-width 1280 --jpeg`,
    max: `go on with agent-atv press ${arrow} --until ${quoted} --max ${max * 2}`,
  };
  throw new AtvError('FOCUS_NOT_FOUND', `${quoted} not found pressing ${arrow}: ${STOPS[w.stop](w)}`, {
    hint: hints[w.stop],
    details: { stop: w.stop, ...body },
  });
}

export function printScan(ctx: Context, w: Walk, arrow: Arrow): void {
  if (ctx.json) return ctx.printJson({ stop: w.stop, presses: w.presses, start: w.start, passed: w.passed, focus: w.focus });
  const ending: Record<Exclude<Stop, 'found'>, string> = {
    no_move: 'then no move reported (the end of the row, or a screen that does not report moves)',
    repeat: `then the focus came back to ${formatFocus(w.focus)} (the row wraps around)`,
    max: `then stopped at --max (more may follow: agent-atv press ${arrow} --scan --max ${w.presses * 2})`,
  };
  ctx.print(`scanned ${arrow}: ${w.passed.length} moves, ${ending[w.stop as Exclude<Stop, 'found'>]}`);
  for (const line of walkLines(w)) ctx.print(line);
}
