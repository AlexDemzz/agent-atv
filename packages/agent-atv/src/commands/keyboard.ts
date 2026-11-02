import { devicePath } from '../client.js';
import type { Command, Context } from '../context.js';
import { usageError } from '../errors.js';
import type { FocusReport, State } from '../output.js';
import { SETTLE_FLAG, printSettledFocus, settleOption } from '../focus.js';

interface KeyboardResponse {
  ok: true;
  keyboard: { focus: string; text: string | null };
  focus?: FocusReport;
  state: State;
}

async function keyboard(ctx: Context, body: { op: 'set' | 'append' | 'clear'; text?: string }): Promise<void> {
  const response = await ctx.client().json<KeyboardResponse>('POST', devicePath(ctx.device(), '/keyboard'), {
    body: { ...body, ...settleOption(ctx) },
  });
  if (ctx.json) return ctx.printJson(response);
  ctx.print(`keyboard: ${JSON.stringify(response.keyboard.text ?? '')}`);
  printSettledFocus(ctx, response.focus);
}

function textArgument(ctx: Context, command: string): string {
  if (ctx.args.positionals.length === 0) {
    throw usageError(`${command} needs the text`, `Example: agent-atv ${command} "stranger things"`);
  }
  return ctx.args.positionals.join(' ');
}

export const type: Command = {
  name: 'type',
  usage: 'type <text> [--settle]',
  summary: 'act: append text to the focused text field',
  flags: [SETTLE_FLAG],
  run: (ctx) => keyboard(ctx, { op: 'append', text: textArgument(ctx, 'type') }),
};

export const fill: Command = {
  name: 'fill',
  usage: 'fill <text> [--settle]',
  summary: 'act: replace the focused text field content',
  flags: [SETTLE_FLAG],
  run: (ctx) => keyboard(ctx, { op: 'set', text: textArgument(ctx, 'fill') }),
};

export const clear: Command = {
  name: 'clear',
  usage: 'clear [--settle]',
  summary: 'act: empty the focused text field',
  flags: [SETTLE_FLAG],
  run: (ctx) => keyboard(ctx, { op: 'clear' }),
};
