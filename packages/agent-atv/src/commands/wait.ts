import { booleanFlag, integerFlag, parseInteger, stringFlag } from '../args.js';
import { devicePath } from '../client.js';
import type { Command, Context } from '../context.js';
import { AtvError, usageError } from '../errors.js';
import {
  formatApp,
  formatFocus,
  formatKeyboard,
  formatPlaybackShort,
  type FocusElement,
  type Foreground,
  type State,
} from '../output.js';

const PLAYBACK_STATES = ['idle', 'loading', 'paused', 'playing', 'stopped', 'seeking'];
const CONDITION_FLAGS = ['app', 'playing', 'paused', 'playback', 'power', 'keyboard', 'no-keyboard', 'text', 'idle', 'focus'];

interface WaitResponse {
  ok: true;
  matched: string[];
  elapsedMs: number;
  focus?: FocusElement | null;
  app?: Foreground | null;
  state: State;
}

function oneOf(value: string, allowed: string[], label: string): string {
  if (!allowed.includes(value)) throw usageError(`${label} must be one of: ${allowed.join(', ')}, got "${value}"`);
  return value;
}

function buildConditions(ctx: Context): Record<string, string | number> {
  const { args } = ctx;
  const conditions: Record<string, string | number> = {};
  const app = stringFlag(args, 'app');
  if (app !== undefined) conditions.app = app;

  const playback = [
    booleanFlag(args, 'playing') ? 'playing' : undefined,
    booleanFlag(args, 'paused') ? 'paused' : undefined,
    stringFlag(args, 'playback'),
  ].filter((value): value is string => value !== undefined);
  if (playback.length > 1) throw usageError('Use only one of --playing, --paused, --playback', 'keep one of them');
  if (playback[0] !== undefined) conditions.playback = oneOf(playback[0], PLAYBACK_STATES, '--playback');

  const power = stringFlag(args, 'power');
  if (power !== undefined) conditions.power = oneOf(power, ['on', 'off'], '--power');

  if (booleanFlag(args, 'keyboard') && booleanFlag(args, 'no-keyboard')) {
    throw usageError('Use either --keyboard or --no-keyboard', 'keep one of them');
  }
  if (booleanFlag(args, 'keyboard')) conditions.keyboard = 'focused';
  if (booleanFlag(args, 'no-keyboard')) conditions.keyboard = 'unfocused';

  const text = stringFlag(args, 'text');
  if (text !== undefined) conditions.text = text;
  const focus = stringFlag(args, 'focus');
  if (focus !== undefined) conditions.focus = focus;
  const idle = integerFlag(args, 'idle', 0, 300000);
  if (idle !== undefined) conditions.idleMs = idle;
  return conditions;
}

interface ScreenReads {
  app?: Foreground | null;
  focus?: FocusElement | null;
}

function appAsFlagValue(app: Foreground | null | undefined): string {
  return app?.kind === 'home' || app?.kind === 'screensaver' ? app.kind : formatApp(app);
}

function describeState(state: State, pending: string[], reads: ScreenReads): string {
  const parts = new Set<string>();
  const playback = formatPlaybackShort(state.playing, state.nowPlaying);
  for (const name of pending.length > 0 ? pending : ['playback']) {
    if (name === 'app') parts.add(`app ${appAsFlagValue(reads.app)}`);
    if (name === 'playback') parts.add(playback);
    if (name === 'power') parts.add(`power ${state.power}`);
    if (name === 'keyboard') parts.add(`keyboard ${state.keyboard.focus}`);
    if (name === 'text') {
      parts.add(playback);
      parts.add(`keyboard ${formatKeyboard(state.keyboard)}`);
    }
    if (name === 'idleMs') parts.add(`still changing (seq ${state.seq})`);
    if (name === 'focus') parts.add(`focus ${formatFocus(reads.focus)}`);
  }
  return [...parts].join(', ');
}

function withStateHint(error: unknown): unknown {
  if (!(error instanceof AtvError) || error.code !== 'WAIT_TIMEOUT') return error;
  const state = error.details.state as State | undefined;
  if (!state?.playing) return error;
  const pending = Array.isArray(error.details.pending) ? (error.details.pending as string[]) : [];
  return new AtvError(error.code, error.message, {
    hint: `Current state: ${describeState(state, pending, error.details as ScreenReads)}. Run agent-atv snapshot to see where you are.`,
    details: error.details,
    status: error.status,
  });
}

export const wait: Command = {
  name: 'wait',
  usage: 'wait [ms] [--app x] [--playing] [--keyboard] [--focus text] [--idle ms] ...',
  summary: 'wait: until conditions hold (AND); a bare number sleeps',
  ownTimeoutFlag: true,
  flags: [
    { name: 'app', value: 'required' },
    { name: 'playing' },
    { name: 'paused' },
    { name: 'playback', value: 'required' },
    { name: 'power', value: 'required' },
    { name: 'keyboard' },
    { name: 'no-keyboard' },
    { name: 'text', value: 'required' },
    { name: 'idle', value: 'required' },
    { name: 'focus', value: 'required' },
    { name: 'timeout', value: 'required' },
  ],
  async run(ctx) {
    const [sleep, ...extra] = ctx.args.positionals;
    const hasConditions = CONDITION_FLAGS.some((flag) => ctx.args.flags.has(flag));
    if (extra.length > 0) throw usageError('wait takes at most one argument (milliseconds)');

    if (sleep !== undefined) {
      if (hasConditions) throw usageError('Use either a bare duration or condition flags, not both', 'e.g. agent-atv wait --idle 2000');
      const ms = parseInteger(sleep, 'wait <ms>', 0, 300000);
      await new Promise((resolve) => setTimeout(resolve, ms));
      if (ctx.json) ctx.printJson({ ok: true, waitedMs: ms });
      else ctx.print(`ok waited ${ms}ms`);
      return;
    }
    if (!hasConditions) {
      throw usageError('wait needs a condition flag or a duration', 'Example: agent-atv wait --app com.netflix.Netflix --idle 1000');
    }

    const conditions = buildConditions(ctx);
    const timeoutMs = integerFlag(ctx.args, 'timeout', 1, 300000) ?? 25000;
    let response: WaitResponse;
    try {
      response = await ctx.client().json<WaitResponse>('POST', devicePath(ctx.device(), '/wait'), {
        body: { conditions, timeoutMs },
        timeoutMs: timeoutMs + 5000,
      });
    } catch (error) {
      throw withStateHint(error);
    }
    if (ctx.json) return ctx.printJson(response);
    const matched = response.matched.map((name) => (name === 'idleMs' ? 'idle' : name));
    ctx.print(`ok ${matched.join(' ')} (${response.elapsedMs}ms)`);
    if (response.focus !== undefined) ctx.print(`Focus: ${formatFocus(response.focus)}`);
  },
};
