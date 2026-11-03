import type { AtvError } from './errors.js';

export interface Playing {
  state: string;
  mediaType: string | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  seriesName: string | null;
  season: number | null;
  episode: number | null;
  position: number | null;
  totalTime: number | null;
}

export interface App {
  bundleId: string;
  name: string;
}

export interface FocusElement {
  label: string | null;
  value: string | null;
  identifier: string | null;
}

export interface Unavailable {
  available: false;
  code: string;
  reason: string;
  hint: string;
}

/** The plugin's report on the focused element (DESIGN.md §6.3); after an action, whether it moved. */
export type FocusReport = { available: true; element: FocusElement; moved?: boolean } | Unavailable;

/** What tvOS shows (DESIGN.md §6.2). */
export type Foreground =
  | ({ kind: 'app' } & App)
  | { kind: 'home' }
  | { kind: 'screensaver' }
  | { kind: 'ambiguous'; apps: App[] };

/** The plugin's report on the foreground app (`state?app=1`). */
export type AppReport = ({ available: true } & Foreground) | Unavailable;

export interface State {
  device: {
    id: string;
    name: string;
    model?: string | null;
    os?: string | null;
    version?: string | null;
    address?: string | null;
  };
  power: string;
  /** The app that last played, not the foreground one. */
  nowPlaying: App | null;
  playing: Playing;
  keyboard: { focus: string; text: string | null };
  volume: number | null;
  protocols?: { companion: boolean; airplay: boolean };
  seq: number;
  changedAt?: string;
  connection: string;
  needsPairing: boolean;
  focus?: FocusReport;
  app?: AppReport;
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const inApp = (nowPlaying: App | null | undefined): string => (nowPlaying ? ` in ${nowPlaying.name}` : '');

/** `<state> <mediaType> "<title>" in <app>`, the short form used in hints. */
export function formatPlaybackShort(playing: Playing, nowPlaying?: App | null): string {
  if (playing.state === 'idle') return 'idle';
  const parts = [playing.state];
  if (playing.mediaType && playing.mediaType !== 'unknown') parts.push(playing.mediaType);
  if (playing.title !== null) parts.push(JSON.stringify(playing.title));
  return parts.join(' ') + inApp(nowPlaying);
}

export function formatPlaying(playing: Playing, nowPlaying?: App | null): string {
  if (playing.state === 'idle') return 'idle';
  let line = formatPlaybackShort(playing);
  if (playing.artist !== null) line += ` - ${playing.artist}`;
  if (playing.seriesName !== null) {
    const episode =
      playing.season !== null && playing.episode !== null ? ` S${playing.season}E${playing.episode}` : '';
    line += ` (${playing.seriesName}${episode})`;
  }
  if (playing.position !== null) {
    line += ` ${formatDuration(playing.position)}`;
    if (playing.totalTime !== null) line += `/${formatDuration(playing.totalTime)}`;
  }
  return line + inApp(nowPlaying);
}

const nameAndId = (app: App): string => `${app.name} (${app.bundleId})`;

/** What tvOS shows, for `App:` lines and hints; `unknown` without a read. */
export function formatApp(app: Foreground | AppReport | null | undefined): string {
  if (!app) return 'unknown';
  if ('available' in app && !app.available) return `unknown, ${app.reason}: ${app.hint}`;
  const shown = app as Foreground;
  switch (shown.kind) {
    case 'app':
      return nameAndId(shown);
    case 'home':
      return 'Home screen';
    case 'screensaver':
      return 'Screensaver';
    case 'ambiguous':
      return `ambiguous, ${shown.apps.map(nameAndId).join(', ')}`;
  }
}

export function formatKeyboard(keyboard: State['keyboard']): string {
  return keyboard.focus === 'focused' ? `focused text=${JSON.stringify(keyboard.text ?? '')}` : keyboard.focus;
}

export function formatVolume(volume: number | null): string {
  return volume === null ? 'n/a' : String(volume);
}

/**
 * `"<label>" (id <identifier>, value <value>)`, without the parts that are null. `unknown` without
 * an element: the plugin did not know the focus (wait), or an older plugin could not read it.
 */
export function formatFocus(element: FocusElement | null | undefined): string {
  if (!element) return 'unknown';
  const details = [
    element.identifier !== null && element.identifier !== element.label ? `id ${element.identifier}` : null,
    element.value !== null ? `value ${element.value.replace(/\s*\n\s*/g, ' ')}` : null,
  ].filter((part) => part !== null);
  const label = element.label !== null ? JSON.stringify(element.label) : null;
  return [label, details.length > 0 ? `(${details.join(', ')})` : null].filter((part) => part !== null).join(' ') || 'unknown';
}

export function formatFocusLine(report: FocusReport): string {
  if (report.available) return `Focus: ${formatFocus(report.element)}${report.moved === false ? ', no move reported' : ''}`;
  return `Focus: unavailable, ${report.reason}: ${report.hint}`;
}

export function formatSnapshot(state: State): string[] {
  const { device } = state;
  const os = [device.os, device.version].filter((part) => part).join(' ');
  const lines = [`Device: ${device.name} (${device.id})${os ? ` ${os}` : ''}, ${state.connection}`];
  if (state.needsPairing) lines.push('Pairing: required (run agent-atv pair)');
  lines.push(`Power: ${state.power}`);
  if (state.app) lines.push(`App: ${formatApp(state.app)}`);
  lines.push(`Playing: ${formatPlaying(state.playing, state.nowPlaying)}`, `Keyboard: ${formatKeyboard(state.keyboard)}`);
  if (state.focus) lines.push(formatFocusLine(state.focus));
  lines.push(`Volume: ${formatVolume(state.volume)}`, `Seq: ${state.seq}`);
  return lines;
}

const SCREEN_REASONS: Record<string, string> = {
  SCREEN_NOT_CONFIGURED: 'screen reading off',
  SCREEN_NOT_PAIRED: 'screen reading not paired',
  SCREEN_UNAVAILABLE: 'screen reading not connected',
  SCREEN_FAILED: 'capture failed',
  DEVICE_OFF: 'Apple TV off',
};

/** A few words on why a screen read failed, for `<thing>: unavailable, <reason>: <hint>` lines. */
export function unavailableReason(error: AtvError): string {
  return SCREEN_REASONS[error.code] ?? error.message;
}

export function formatErrorText(error: AtvError): string {
  const lines = [`error: ${error.message} (${error.code})`];
  if (error.hint) lines.push(`hint: ${error.hint}`);
  return `${lines.join('\n')}\n`;
}

export function printFocus(print: (line: string) => void, report: FocusReport | undefined): void {
  if (report) print(formatFocusLine(report));
}
