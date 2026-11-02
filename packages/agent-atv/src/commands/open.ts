import { booleanFlag, integerFlag } from '../args.js';
import { devicePath } from '../client.js';
import type { Command } from '../context.js';
import { usageError } from '../errors.js';
import type { App, FocusReport, State, Unavailable } from '../output.js';
import { SETTLE_FLAG, printSettledFocus, settleOption } from '../focus.js';

interface OpenResponse {
  ok: true;
  app: App | null;
  /** null: screen reading could not tell (`foregroundUnknown` says why). */
  foreground: boolean | null;
  foregroundUnknown?: Omit<Unavailable, 'available'>;
  focus?: FocusReport;
  state: State;
}

export const open: Command = {
  name: 'open',
  usage: 'open <app name|bundle id|url> [--settle]',
  summary: 'act: launch an app or URL and wait for it in the foreground',
  flags: [{ name: 'no-wait' }, { name: 'wait-ms', value: 'required' }, SETTLE_FLAG],
  async run(ctx) {
    const target = ctx.args.positionals.join(' ');
    if (target === '') throw usageError('open needs a target', 'Example: agent-atv open Netflix');
    const waitMs = booleanFlag(ctx.args, 'no-wait') ? 0 : (integerFlag(ctx.args, 'wait-ms', 0, 60000) ?? 15000);

    const client = ctx.client();
    const response = await client.json<OpenResponse>('POST', devicePath(ctx.device(), '/open'), {
      body: { target, waitMs, ...settleOption(ctx) },
      timeoutMs: Math.max(client.timeoutMs, waitMs + 15000),
    });
    if (ctx.json) return ctx.printJson(response);

    if (response.foreground && response.app) {
      ctx.print(`opened ${response.app.name} (${response.app.bundleId})`);
    } else {
      const launched = target.includes('://') ? target : (response.app?.bundleId ?? target);
      const unknown = response.foregroundUnknown;
      let suffix = '';
      if (unknown) suffix = ` (foreground app not known, ${unknown.reason}: ${unknown.hint})`;
      else if (waitMs > 0 && !target.includes('://')) suffix = ` (not in foreground after ${waitMs}ms)`;
      ctx.print(`launched ${launched}${suffix}`);
    }
    printSettledFocus(ctx, response.focus);
  },
};
