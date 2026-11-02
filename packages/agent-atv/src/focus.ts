import { booleanFlag } from './args.js';
import type { Context } from './context.js';
import { printFocus, type FocusReport } from './output.js';

/** snapshot reads the focused element unless --no-focus. */
export const NO_FOCUS_FLAG = { name: 'no-focus' };

export function skipsFocus(ctx: Context): boolean {
  return booleanFlag(ctx.args, 'no-focus');
}

/** Actions are silent; --settle also waits for the focus to settle and prints it. */
export const SETTLE_FLAG = { name: 'settle' };

export function settles(ctx: Context): boolean {
  return booleanFlag(ctx.args, 'settle');
}

/** The request body field that asks an action route for the settled focus. */
export function settleOption(ctx: Context): { focus?: true } {
  return settles(ctx) ? { focus: true } : {};
}

/** The `Focus:` line after an action's own line, only when it asked for one. */
export function printSettledFocus(ctx: Context, report: FocusReport | undefined): void {
  if (settles(ctx)) printFocus((line) => ctx.print(line), report);
}
