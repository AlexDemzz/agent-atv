import { booleanFlag, integerFlag } from '../args.js';
import { devicePath } from '../client.js';
import type { Command, Context } from '../context.js';
import { usageError } from '../errors.js';
import { formatKeyPress, type KeyAction, type KeyPress, parseKeySpec } from '../keys.js';
import { SETTLE_FLAG, printSettledFocus, settleOption } from '../focus.js';
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

async function pressAndReport(ctx: Context, specs: string[]): Promise<void> {
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
  usage: 'press <key[:action][*n]...> [--settle]',
  summary: 'act: press remote keys (up down left right select menu home play_pause ...)',
  flags: PRESS_FLAGS,
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
