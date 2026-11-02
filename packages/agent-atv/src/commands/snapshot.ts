import { devicePath } from '../client.js';
import type { Command } from '../context.js';
import { AtvError } from '../errors.js';
import { formatSnapshot, unavailableReason, type State } from '../output.js';
import { NO_FOCUS_FLAG, skipsFocus } from '../focus.js';
import { CAPTURE_FLAGS, capture, captureOptions } from './screenshot.js';

export const snapshot: Command = {
  name: 'snapshot',
  usage: 'snapshot [--screenshot [path] [--max-width <px>] [--jpeg]] [--no-focus]',
  summary: 'observe: device, power, app, playback, keyboard, focused element, volume',
  flags: [{ name: 'screenshot', value: 'optional' }, ...CAPTURE_FLAGS, NO_FOCUS_FLAG],
  async run(ctx) {
    const options = captureOptions(ctx, 'agent-atv snapshot --screenshot --max-width 1280 --jpeg');
    const query = skipsFocus(ctx) ? '/state?refresh=1&app=1' : '/state?refresh=1&focus=1&app=1';
    const state = await ctx.client().json<State>('GET', devicePath(ctx.device(), query));
    const wanted = ctx.args.flags.get('screenshot');
    if (wanted === undefined) {
      if (ctx.json) return ctx.printJson(state);
      for (const line of formatSnapshot(state)) ctx.print(line);
      return;
    }

    let shot: Record<string, unknown>;
    let line: string;
    try {
      const result = await capture(ctx, state.device.id, wanted === true ? undefined : wanted, false, options);
      if (!result.changed) throw new Error('unexpected 304');
      shot = { path: result.path, sha256: result.sha256, width: result.width, height: result.height };
      line = `Screenshot: ${result.path} (${result.width}x${result.height})`;
    } catch (caught) {
      const error = caught instanceof AtvError ? caught : new AtvError('INTERNAL', (caught as Error).message);
      shot = error.toBody();
      line = `Screenshot: unavailable, ${unavailableReason(error)}: ${error.hint || 'run agent-atv doctor'}`;
    }
    if (ctx.json) return ctx.printJson({ ...state, screenshot: shot });
    for (const text of formatSnapshot(state)) ctx.print(text);
    ctx.print(line);
  },
};
