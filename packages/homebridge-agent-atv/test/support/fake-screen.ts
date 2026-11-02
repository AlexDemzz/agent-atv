import { writeFile } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import { BridgeFailure, type FakeBridge } from './fake-bridge';

export const RP_IDENTIFIER = '0A1B2C3D-0000-4000-8000-00000000AA01';
export const RP_PIN = '123456';

export interface Element {
  label: string | null;
  value: string | null;
  identifier: string | null;
}

/** A read before tvOS moved the focus since the worker's tunnel opened. */
export const UNKNOWN = 'focus-unknown' as const;

/** What the worker's `foreground` read answers (DESIGN.md §6.2). */
export type Foreground =
  | { kind: 'app'; bundleId: string; name: string }
  | { kind: 'home' }
  | { kind: 'screensaver' }
  | { kind: 'ambiguous'; apps: { bundleId: string; name: string }[] };

export const HOME_FOCUS: Element = { label: 'TV', value: null, identifier: 'app-icon/com.apple.TVWatchList' };

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

export function png(width: number, height: number, label = 'frame'): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(2, 9);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('tEXt', Buffer.from(`Comment\0${label}`, 'latin1')),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Only the markers that carry the size, as the Python fake worker writes them: SOI, SOF0, EOI. */
export function jpeg(width: number, height: number): Buffer {
  const sof = Buffer.alloc(17);
  sof.writeUInt16BE(17, 0);
  sof.writeUInt8(8, 2);
  sof.writeUInt16BE(height, 3);
  sof.writeUInt16BE(width, 5);
  sof.writeUInt8(3, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0]), sof, Buffer.from([0xff, 0xd9])]);
}

/**
 * Scripts `worker` as the screen worker of one Apple TV (DESIGN.md §6.2), close to the Python
 * worker's fake backend. `reads` queues the next focus reads; the last one repeats. `movedAt` is
 * when tvOS last reported a focus move (epoch ms); unset, every read has just moved.
 */
export function installScreen(worker: FakeBridge, options: { paired?: boolean; identifier?: string } = {}) {
  const screen = {
    paired: options.paired ?? true,
    identifier: options.identifier ?? RP_IDENTIFIER,
    tunnel: 'connected' as 'connected' | 'connecting' | 'disconnected',
    reads: [HOME_FOCUS] as (Element | typeof UNKNOWN)[],
    movedAt: undefined as number | undefined,
    /** How long a focus reply takes to reach the plugin after the worker measured ageMs. */
    replyDelayMs: 0,
    image: png(3840, 2160),
    focusReads: 0,
    foreground: { kind: 'home' } as Foreground,
    /** How many next foreground reads find nothing but the shell in front (SCREEN_FAILED). */
    foregroundFailures: 0,
    foregroundReads: 0,
    status() {
      return { tunnel: this.paired ? this.tunnel : 'unpaired', identifier: this.paired ? this.identifier : null, error: null };
    },
    push() {
      worker.event('status', undefined, this.status());
    },
  };
  worker.readyEvent = { protocolVersion: 1, workerVersion: '0.1.0', python: '3.11.2', pymobiledevice3: '11.49.1', backend: 'pmd3' };
  worker.afterReady = () => [{ event: 'status', data: screen.status() }];
  const requirePaired = () => {
    if (!screen.paired) throw new BridgeFailure('SCREEN_NOT_PAIRED', 'No RemotePairing pair record for this Apple TV');
  };
  worker
    .handle('focus', async () => {
      requirePaired();
      screen.focusReads += 1;
      const focus = screen.reads.length > 1 ? screen.reads.shift()! : screen.reads[0]!;
      if (focus === UNKNOWN) {
        throw new BridgeFailure('FOCUS_UNKNOWN', 'The focused element is not known yet: the Apple TV reports it only when the focus moves');
      }
      const ageMs = screen.movedAt === undefined ? 0 : Date.now() - screen.movedAt;
      if (screen.replyDelayMs) await new Promise((resolve) => setTimeout(resolve, screen.replyDelayMs));
      return { focus, ageMs };
    })
    .handle('foreground', () => {
      requirePaired();
      screen.foregroundReads += 1;
      if (screen.foregroundFailures > 0) {
        screen.foregroundFailures -= 1;
        throw new BridgeFailure('SCREEN_FAILED', 'The Apple TV reported no app in the foreground');
      }
      return screen.foreground;
    })
    .handle('screenshot', async (params) => {
      requirePaired();
      await writeFile(String(params.path), screen.image, { mode: 0o600 });
      return { bytes: screen.image.length };
    })
    .handle('pair.begin', () => ({}))
    .handle('pair.pin', (params) => {
      if (params.pin !== RP_PIN) throw new BridgeFailure('PAIRING_FAILED', 'RemotePairing failed: PairingError: Authentication');
      screen.paired = true;
      setImmediate(() => screen.push());
      return { identifier: screen.identifier };
    })
    .handle('pair.cancel', () => ({}));
  return screen;
}
