import { booleanFlag, integerFlag, stringFlag } from '../args.js';
import { devicePath } from '../client.js';
import type { Command, Context } from '../context.js';
import { usageError } from '../errors.js';
import { formatKeyPress, type KeyAction, type KeyPress, parseKeySpec } from '../keys.js';
import { SETTLE_FLAG, printSettledFocus, settleOption } from '../focus.js';
import { ARROWS, type Arrow, currentFocus, printScan, printUntil, walk } from '../navigate.js';
import type { FocusReport, State } from '../output.js';

export interface KeysResponse {
  ok: true;
  pressed: number;
  focus?: FocusReport;
  state: State;
}

export async function sendKeys(
  ctx: Context,
  presses: KeyPress[],
  options: { intervalMs?: number; focus?: true } = {},
): Promise<KeysResponse> {
  const { intervalMs = 200, ...rest } = options;
  return ctx.client().json<KeysResponse>('POST', devicePath(ctx.device(), '/keys'), {
    body: { keys: presses, intervalMs, ...rest },
  });
}

const PRESS_FLAGS = [
  { name: 'interval', value: 'required' as const },
  { name: 'hold' },
  { name: 'double' },
  SETTLE_FLAG,
];

const NAVIGATE_FLAGS = [{ name: 'until', value: 'required' as const }, { name: 'scan' }, { name: 'max', value: 'required' as const }];
const DEFAULT_MAX = 20;

/** `--until <text>` and `--scan`: one arrow, pressed one key at a time, steering by the focus. */
async function navigate(ctx: Context, specs: string[]): Promise<boolean> {
  const until = stringFlag(ctx.args, 'until');
  const scan = booleanFlag(ctx.args, 'scan');
  if (until === undefined && !scan) {
    if (ctx.args.flags.has('max')) throw usageError('--max goes with --until or --scan', 'e.g. agent-atv press right --until "Season 2" --max 30');
    return false;
  }
  const example = 'e.g. agent-atv press right --until "Season 2", or agent-atv press down --scan';
  if (until !== undefined && scan) throw usageError('Use either --until or --scan, not both', example);
  if (until !== undefined && until.trim() === '') throw usageError('--until needs the text to look for', example);
  const press = specs.length === 1 ? parseKeySpec(specs[0]!) : undefined;
  if (!press || press.count !== 1 || press.action !== 'tap' || !(ARROWS as readonly string[]).includes(press.key)) {
    throw usageError(`--${scan ? 'scan' : 'until'} takes one arrow key: up, down, left or right`, example);
  }
  if (booleanFlag(ctx.args, 'hold') || booleanFlag(ctx.args, 'double') || ctx.args.flags.has('interval')) {
    throw usageError(`--${scan ? 'scan' : 'until'} presses plain taps, one at a time`, example);
  }
  const arrow = press.key as Arrow;
  const max = integerFlag(ctx.args, 'max', 1, 100) ?? DEFAULT_MAX;
  const start = await currentFocus(ctx);
  const pressArrow = async (key: Arrow) => (await sendKeys(ctx, [{ key, action: 'tap', count: 1 }], { focus: true })).focus;
  const result = await walk(pressArrow, arrow, start, max, until);
  if (scan) printScan(ctx, result, arrow);
  else printUntil(ctx, result, arrow, until!, max);
  return true;
}

async function pressAndReport(ctx: Context, specs: string[]): Promise<void> {
  if (await navigate(ctx, specs)) return;
  if (specs.length === 0) throw usageError('press needs at least one key', 'Example: agent-atv press down*2 right select');
  const hold = booleanFlag(ctx.args, 'hold');
  const double = booleanFlag(ctx.args, 'double');
  if (hold && double) throw usageError('Use either --hold or --double, not both', 'keep one of them, or put the action in the key spec: select:hold');
  const defaultAction: KeyAction = hold ? 'hold' : double ? 'double' : 'tap';
  const presses = specs.map((spec) => parseKeySpec(spec, defaultAction));
  const intervalMs = integerFlag(ctx.args, 'interval', 0, 5000) ?? 200;

  const response = await sendKeys(ctx, presses, { intervalMs, ...settleOption(ctx) });
  if (ctx.json) return ctx.printJson(response);
  ctx.print(`pressed ${presses.map(formatKeyPress).join(' ')}`);
  printSettledFocus(ctx, response.focus);
}

export const press: Command = {
  name: 'press',
  usage: 'press <key[:action][*n]...> [--settle] | press <arrow> --until <text> [--max n] | press <arrow> --scan [--max n]',
  summary: 'act: press remote keys (up down left right select menu home play_pause ...); --until steers to an element, --scan lists a row',
  flags: [...PRESS_FLAGS, ...NAVIGATE_FLAGS],
  run: (ctx) => pressAndReport(ctx, ctx.args.positionals),
};

export const back: Command = {
  name: 'back',
  usage: 'back [--settle]',
  summary: 'press menu (go back)',
  flags: PRESS_FLAGS,
  run: (ctx) => pressAndReport(ctx, ['menu']),
};

export const home: Command = {
  name: 'home',
  usage: 'home [--settle]',
  summary: 'press home',
  flags: PRESS_FLAGS,
  run: (ctx) => pressAndReport(ctx, ['home']),
};
