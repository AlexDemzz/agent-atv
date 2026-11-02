import { integerFlag, parseInteger } from '../args.js';
import { devicePath } from '../client.js';
import type { Command } from '../context.js';
import { AtvError, usageError } from '../errors.js';
import { formatDuration, formatVolume, type State } from '../output.js';
import { sendKeys } from './press.js';
import { fetchState } from './state.js';

/** Above the plugin's power.set timeout: the plugin waits up to about 35 s for the Apple TV to confirm. */
const POWER_TIMEOUT_MS = 50_000;

export const power: Command = {
  name: 'power',
  usage: 'power [on|off|toggle]',
  summary: 'print or set the power state',
  async run(ctx) {
    const [arg] = ctx.args.positionals;
    if (arg !== undefined && !['on', 'off', 'toggle'].includes(arg)) {
      throw usageError(`power takes on, off or toggle, got "${arg}"`);
    }
    if (arg === undefined) {
      const current = await fetchState(ctx);
      if (ctx.json) return ctx.printJson({ power: current.power });
      return ctx.print(`power: ${current.power}`);
    }
    const on = arg === 'toggle' ? (await fetchState(ctx)).power !== 'on' : arg === 'on';
    const client = ctx.client();
    const response = await client.json<{ ok: true; power: string; state: State }>('POST', devicePath(ctx.device(), '/power'), {
      body: { on },
      timeoutMs: Math.max(client.timeoutMs, POWER_TIMEOUT_MS),
    });
    if (ctx.json) return ctx.printJson(response);
    ctx.print(`power: ${response.power}`);
  },
};

export const volume: Command = {
  name: 'volume',
  usage: 'volume [level|up|down]',
  summary: 'print or set the volume (0-100), or step it with --step n',
  flags: [{ name: 'step', value: 'required' }],
  async run(ctx) {
    const [arg] = ctx.args.positionals;
    if (arg === undefined) {
      const current = await fetchState(ctx);
      if (ctx.json) return ctx.printJson({ volume: current.volume });
      return ctx.print(`volume: ${formatVolume(current.volume)}`);
    }
    if (arg === 'up' || arg === 'down') {
      const count = integerFlag(ctx.args, 'step', 1, 50) ?? 1;
      const response = await sendKeys(ctx, [{ key: `volume_${arg}`, action: 'tap', count }]);
      if (ctx.json) return ctx.printJson(response);
      return ctx.print(`volume: ${formatVolume(response.state.volume)}`);
    }
    const level = parseInteger(arg, 'volume level', 0, 100);
    const response = await ctx
      .client()
      .json<{ ok: true; volume: number | null; state: State }>('POST', devicePath(ctx.device(), '/volume'), {
        body: { level },
      });
    if (ctx.json) return ctx.printJson(response);
    ctx.print(`volume: ${formatVolume(response.volume)}`);
  },
};

function parseClock(text: string): number | undefined {
  if (/^\d+$/.test(text)) return Number(text);
  const parts = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(text);
  if (!parts) return undefined;
  const [, hours, minutes, seconds] = parts;
  if (Number(seconds) > 59 || (hours !== undefined && Number(minutes) > 59)) return undefined;
  return Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
}

export const seek: Command = {
  name: 'seek',
  usage: 'seek <seconds|+n|-n|mm:ss|h:mm:ss>',
  summary: 'act: jump to a position, absolute or relative',
  async run(ctx) {
    const [arg = ''] = ctx.args.positionals;
    const sign = arg.startsWith('+') ? 1 : arg.startsWith('-') ? -1 : 0;
    const amount = parseClock(sign === 0 ? arg : arg.slice(1));
    if (amount === undefined) {
      throw usageError(`Invalid position "${arg}"`, 'Examples: agent-atv seek 90, seek +30, seek -10, seek 12:33, seek 1:02:03');
    }
    let position = amount;
    if (sign !== 0) {
      const current = await fetchState(ctx, true);
      if (current.playing.position === null) {
        throw new AtvError('NOTHING_PLAYING', `No playback position on ${current.device.name}`, {
          hint: 'Start playback first (agent-atv press play), or seek to an absolute position. Check with: agent-atv state playing',
        });
      }
      position = Math.max(0, current.playing.position + sign * amount);
    }
    const response = await ctx.client().json<{ ok: true; state: State }>('POST', devicePath(ctx.device(), '/seek'), {
      body: { position },
    });
    if (ctx.json) return ctx.printJson(response);
    ctx.print(`position: ${formatDuration(position)}`);
  },
};
