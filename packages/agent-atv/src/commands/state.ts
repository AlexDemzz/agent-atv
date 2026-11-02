import { devicePath } from '../client.js';
import type { Command, Context } from '../context.js';
import { AtvError, usageError } from '../errors.js';
import {
  formatFocus,
  formatPlaying,
  formatSnapshot,
  formatVolume,
  type App,
  type AppReport,
  type FocusElement,
  type State,
} from '../output.js';

const idAndName = (app: App): string => `${app.bundleId} ${app.name}`;

/** `state app`: what tvOS shows, or the screen error that keeps it from knowing. */
function formatForeground(report: AppReport | undefined): string {
  if (!report?.available) {
    const reason = report?.reason ?? 'the plugin did not read it';
    throw new AtvError(report?.code ?? 'SCREEN_FAILED', `The foreground app is not known: ${reason}`, {
      hint: report?.hint ?? 'update homebridge-agent-atv in the Homebridge UI, then restart Homebridge',
    });
  }
  switch (report.kind) {
    case 'app':
      return idAndName(report);
    case 'home':
      return 'home screen';
    case 'screensaver':
      return 'screensaver';
    case 'ambiguous':
      return `ambiguous: ${report.apps.map(idAndName).join(', ')}`;
  }
}

const FIELDS: Record<string, (state: State) => string> = {
  power: (state) => state.power,
  app: (state) => formatForeground(state.app),
  playing: (state) => formatPlaying(state.playing, state.nowPlaying),
  keyboard: (state) =>
    state.keyboard.focus === 'focused' ? `focused ${JSON.stringify(state.keyboard.text ?? '')}` : state.keyboard.focus,
  volume: (state) => formatVolume(state.volume),
  connection: (state) => state.connection,
  seq: (state) => String(state.seq),
};

export async function fetchState(ctx: Context, refresh = false): Promise<State> {
  return ctx.client().json<State>('GET', devicePath(ctx.device(), refresh ? '/state?refresh=1' : '/state'));
}

export const state: Command = {
  name: 'state',
  usage: 'state [power|app|playing|keyboard|focus|volume|connection|seq]',
  summary: 'observe one field cheaply (cached state)',
  async run(ctx) {
    const [field, ...extra] = ctx.args.positionals;
    if (extra.length > 0) throw usageError('state takes at most one field', 'e.g. agent-atv state focus');
    if (field !== undefined && field !== 'focus' && !(field in FIELDS)) {
      throw usageError(`Unknown state field "${field}"`, `use one of: ${[...Object.keys(FIELDS), 'focus'].join(', ')}`);
    }
    if (field === 'focus') {
      const { focus } = await ctx.client().json<{ focus: FocusElement | null }>('GET', devicePath(ctx.device(), '/focus'));
      if (ctx.json) return ctx.printJson({ focus });
      return ctx.print(formatFocus(focus));
    }
    // The foreground app is read live, like the focus; the other fields come from the cache.
    const current =
      field === 'app' ? await ctx.client().json<State>('GET', devicePath(ctx.device(), '/state?app=1')) : await fetchState(ctx);
    if (field === undefined) {
      if (ctx.json) return ctx.printJson(current);
      for (const line of formatSnapshot(current)) ctx.print(line);
      return;
    }
    if (ctx.json) return ctx.printJson({ [field]: current[field as keyof State] });
    ctx.print((FIELDS[field] as (state: State) => string)(current));
  },
};
