import type { Playing } from '../bridge/protocol';
import type { PluginState } from '../devices/manager';
import type { FocusElement, Foreground } from '../screen/service';

export const PLAYBACK_STATES: readonly Playing['state'][] = ['idle', 'loading', 'paused', 'playing', 'stopped', 'seeking'];

export interface Conditions {
  app?: string;
  playback?: Playing['state'];
  power?: 'on' | 'off';
  keyboard?: 'focused' | 'unfocused';
  text?: string;
  idleMs?: number;
  focus?: string;
}

export const CONDITION_NAMES = ['app', 'playback', 'power', 'keyboard', 'text', 'idleMs', 'focus'] as const;

export interface Clock {
  now: number;
  waitStartedAt: number;
  /** The last focused element read, for the `focus` condition. */
  focus?: FocusElement | null;
  /** The last foreground read, for the `app` condition. */
  app?: Foreground | null;
}

export interface Evaluation {
  satisfied: boolean;
  matched: string[];
  pending: string[];
}

type Check = (state: PluginState, value: never, clock: Clock) => boolean;

const contains = (fields: (string | null | undefined)[], value: string): boolean => {
  const needle = value.toLowerCase();
  return fields.some((field) => typeof field === 'string' && field.toLowerCase().includes(needle));
};

const CHECKS: Record<(typeof CONDITION_NAMES)[number], Check> = {
  app: (_state, value: string, { app }) =>
    app?.kind === 'app'
      ? app.bundleId === value || app.name.toLowerCase() === value.toLowerCase()
      : (app?.kind === 'home' || app?.kind === 'screensaver') && app.kind === value.toLowerCase(),
  playback: (state, value: string) => state.playing.state === value,
  power: (state, value: string) => state.power === value,
  keyboard: (state, value: string) => state.keyboard.focus === value,
  text: (state, value: string) =>
    contains(
      [state.nowPlaying?.name, state.playing.title, state.playing.artist, state.playing.album, state.playing.seriesName, state.keyboard.text],
      value,
    ),
  idleMs: (state, value: number, { now, waitStartedAt }) =>
    now - Math.max(Date.parse(state.changedAt), waitStartedAt) >= value,
  focus: (_state, value: string, { focus }) => focus != null && contains([focus.label, focus.value, focus.identifier], value),
};

/** DESIGN.md §3.6: every given condition must hold at once. */
export function evaluate(
  state: PluginState,
  conditions: Conditions,
  clock: Clock,
): Evaluation {
  const matched: string[] = [];
  const pending: string[] = [];
  for (const name of Object.keys(conditions) as (keyof Conditions)[]) {
    const value = conditions[name];
    if (value === undefined) continue;
    if ((CHECKS[name] as (s: PluginState, v: unknown, c: typeof clock) => boolean)(state, value, clock)) matched.push(name);
    else pending.push(name);
  }
  return { satisfied: pending.length === 0 && matched.length > 0, matched, pending };
}
