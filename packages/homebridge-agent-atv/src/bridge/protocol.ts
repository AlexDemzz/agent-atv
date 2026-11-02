export const MAX_LINE_BYTES = 4 * 1024 * 1024;

export type Json = Record<string, unknown>;

export interface DeviceInfo {
  id: string;
  name: string;
  model: string | null;
  os: string | null;
  version: string | null;
  address: string | null;
  mac: string | null;
}

export interface Playing {
  state: 'idle' | 'loading' | 'paused' | 'playing' | 'stopped' | 'seeking';
  mediaType: 'unknown' | 'video' | 'music' | 'tv';
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

export interface Keyboard {
  focus: 'focused' | 'unfocused' | 'unknown';
  text: string | null;
}

/** State as emitted by the bridge (DESIGN.md §2.5). */
export interface BridgeState {
  device: DeviceInfo;
  power: 'on' | 'off' | 'unknown';
  /** The MRP now-playing client: the last app that played, not the foreground app. */
  nowPlaying: App | null;
  playing: Playing;
  keyboard: Keyboard;
  volume: number | null;
  protocols: { companion: boolean; airplay: boolean };
}

export interface ScanService {
  protocol: string;
  port: number;
  pairing: string;
}

export interface ScanDevice {
  id: string;
  name: string;
  address: string;
  mac: string | null;
  model: string | null;
  os: string | null;
  version: string | null;
  identifiers: string[];
  services: ScanService[];
}

export interface ReadyEvent {
  protocolVersion: number;
  bridgeVersion: string;
  python: string | null;
  pyatv: string | null;
  backend: 'pyatv' | 'fake';
}

export interface ConnectionEvent {
  status: 'disconnected';
  reason: string;
  message?: string;
}

export interface BridgeErrorBody {
  code: string;
  message: string;
  details?: Json;
}

export type BridgeMessage =
  | { kind: 'response'; id: number | null; ok: true; result: Json }
  | { kind: 'response'; id: number | null; ok: false; error: BridgeErrorBody }
  | { kind: 'event'; event: string; device?: string; data: unknown };

const SECOND = 1000;

/** Plugin-side timeouts per method (DESIGN.md §2.4). */
export function methodTimeoutMs(method: string, params: Json): number {
  switch (method) {
    case 'ping':
      return 5 * SECOND;
    case 'scan':
      return (typeof params.timeoutMs === 'number' ? params.timeoutMs : 5000) + 10 * SECOND;
    case 'pair.begin':
    case 'pair.pin':
    case 'pair.verify':
    case 'connect':
      return 30 * SECOND;
    case 'apps.list':
    case 'app.launch':
    case 'power.set':
      return 15 * SECOND;
    default:
      return 10 * SECOND;
  }
}

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Parses one stdout line. Returns null for anything that isn't a protocol message. */
export function parseMessage(line: string): BridgeMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (typeof value.event === 'string') {
    if (!isRecord(value.data)) return null;
    const message: BridgeMessage = { kind: 'event', event: value.event, data: value.data };
    if (typeof value.device === 'string') message.device = value.device;
    return message;
  }
  if (!('id' in value) || typeof value.ok !== 'boolean') return null;
  const id = typeof value.id === 'number' ? value.id : null;
  if (value.ok) return { kind: 'response', id, ok: true, result: isRecord(value.result) ? value.result : {} };
  const error = isRecord(value.error) ? value.error : {};
  return {
    kind: 'response',
    id,
    ok: false,
    error: {
      code: typeof error.code === 'string' ? error.code : 'INTERNAL',
      message: typeof error.message === 'string' ? error.message : 'Bridge error',
      details: isRecord(error.details) ? error.details : {},
    },
  };
}

/** Splits a byte stream into lines, dropping lines longer than `maxBytes`. */
export class LineSplitter {
  private chunks: Buffer[] = [];
  private size = 0;
  private overflowing = false;

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly onOverflow: () => void,
    private readonly maxBytes = MAX_LINE_BYTES,
  ) {}

  push(chunk: Buffer): void {
    let start = 0;
    for (;;) {
      const index = chunk.indexOf(0x0a, start);
      if (index < 0) break;
      this.append(chunk.subarray(start, index));
      this.flush();
      start = index + 1;
    }
    this.append(chunk.subarray(start));
  }

  private append(part: Buffer): void {
    if (part.length === 0 || this.overflowing) return;
    if (this.size + part.length > this.maxBytes) {
      this.overflowing = true;
      this.chunks = [];
      this.size = 0;
      return;
    }
    this.chunks.push(part);
    this.size += part.length;
  }

  private flush(): void {
    if (this.overflowing) {
      this.overflowing = false;
      this.onOverflow();
      return;
    }
    const line = Buffer.concat(this.chunks).toString('utf8');
    this.chunks = [];
    this.size = 0;
    if (line.trim() !== '') this.onLine(line);
  }
}

/** Keys that accept `double` and `hold` (DESIGN.md §2.6). */
export const ACTION_KEYS = ['up', 'down', 'left', 'right', 'select', 'menu', 'home'] as const;
export const TAP_ONLY_KEYS = [
  'home_hold',
  'top_menu',
  'play',
  'pause',
  'play_pause',
  'stop',
  'next',
  'previous',
  'volume_up',
  'volume_down',
  'channel_up',
  'channel_down',
  'screensaver',
  'guide',
  'control_center',
  'skip_forward',
  'skip_backward',
] as const;
export const KEYS: readonly string[] = [...ACTION_KEYS, ...TAP_ONLY_KEYS];
export const KEY_ACTIONS = ['tap', 'double', 'hold'] as const;
export type KeyAction = (typeof KEY_ACTIONS)[number];
