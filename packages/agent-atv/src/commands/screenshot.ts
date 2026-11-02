import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { booleanFlag, integerFlag } from '../args.js';
import { devicePath } from '../client.js';
import { cacheDir } from '../config.js';
import type { Command, Context } from '../context.js';
import { AtvError, usageError } from '../errors.js';
import { fetchState } from './state.js';

export type Capture =
  | { changed: true; path: string; sha256: string; width: number; height: number; durationMs: number }
  | { changed: false; path: string; sha256: string };

interface CacheEntry {
  sha256: string;
  path: string;
}

function cacheFile(ctx: Context): string {
  return join(cacheDir(ctx.io.env), 'last-screenshot.json');
}

function readCache(ctx: Context): Record<string, CacheEntry> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(cacheFile(ctx), 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, CacheEntry>) : {};
  } catch {
    return {};
  }
}

function writeCache(ctx: Context, deviceId: string, entry: CacheEntry): void {
  const file = cacheFile(ctx);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify({ ...readCache(ctx), [deviceId]: entry })}\n`);
}

function timestamp(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}`;
}

/** The plugin's worst case: a worker start (20 s), then a reconnect, a failed capture, a reconnect and a retry (110 s). */
const CAPTURE_TIMEOUT_MS = 150_000;

function writeFailed(path: string, error: unknown): AtvError {
  return new AtvError('WRITE_FAILED', `Cannot write the screenshot to ${path}: ${(error as Error).message}`, {
    hint: 'pass a writable path, e.g. agent-atv screenshot ./tv.png',
    details: { path },
  });
}

/** os.tmpdir() may be shared with other users (/tmp on Linux), so the directory must be ours and private. */
function privateScreenshotDir(): string {
  const dir = join(tmpdir(), 'agent-atv');
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stats = lstatSync(dir);
    if (!stats.isDirectory() || (process.getuid !== undefined && stats.uid !== process.getuid())) {
      throw new Error(`${dir} is not a directory owned by you`);
    }
    if ((stats.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  } catch (error) {
    throw writeFailed(dir, error);
  }
  return dir;
}

export interface CaptureOptions {
  maxWidth?: number;
  format?: 'jpeg';
}

export function defaultScreenshotPath(deviceId: string, extension = 'png'): string {
  const safeId = deviceId.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(privateScreenshotDir(), `screenshot-${safeId}-${timestamp(new Date())}.${extension}`);
}

const MAX_WIDTH = { min: 160, max: 3840 };

export const CAPTURE_FLAGS = [{ name: 'max-width', value: 'required' as const }, { name: 'jpeg' }];

/** `example`: the command line the usage error suggests, e.g. `agent-atv screenshot --max-width 1280 --jpeg`. */
export function captureOptions(ctx: Context, example: string): CaptureOptions {
  let maxWidth: number | undefined;
  try {
    maxWidth = integerFlag(ctx.args, 'max-width', MAX_WIDTH.min, MAX_WIDTH.max);
  } catch (error) {
    throw usageError((error as Error).message, `e.g. ${example}`);
  }
  return { ...(maxWidth === undefined ? {} : { maxWidth }), ...(booleanFlag(ctx.args, 'jpeg') ? { format: 'jpeg' as const } : {}) };
}

export async function capture(
  ctx: Context,
  deviceId: string,
  target: string | undefined,
  ifChanged: boolean,
  options: CaptureOptions = {},
): Promise<Capture> {
  const previous = ifChanged ? readCache(ctx)[deviceId] : undefined;
  const client = ctx.client();
  const response = await client.raw('POST', devicePath(ctx.device(), '/screenshot'), {
    body: { ...options, ...(previous ? { ifNoneMatch: previous.sha256 } : {}) },
    timeoutMs: Math.max(client.timeoutMs, CAPTURE_TIMEOUT_MS),
  });
  if (response.status === 304 && previous) {
    return { changed: false, path: previous.path, sha256: previous.sha256 };
  }

  const image = Buffer.from(await response.arrayBuffer());
  // From what came back: a plugin older than --jpeg answers a PNG.
  const extension = response.headers.get('content-type') === 'image/jpeg' ? 'jpg' : 'png';
  const path = resolve(target ?? defaultScreenshotPath(deviceId, extension));
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, image);
  } catch (error) {
    throw writeFailed(path, error);
  }
  const sha256 = response.headers.get('x-agent-atv-sha256') ?? createHash('sha256').update(image).digest('hex');
  writeCache(ctx, deviceId, { sha256, path });
  return {
    changed: true,
    path,
    sha256,
    width: Number(response.headers.get('x-agent-atv-width') ?? 0),
    height: Number(response.headers.get('x-agent-atv-height') ?? 0),
    durationMs: Number(response.headers.get('x-agent-atv-duration-ms') ?? 0),
  };
}

export const screenshot: Command = {
  name: 'screenshot',
  usage: 'screenshot [path] [--max-width <px>] [--jpeg] [--if-changed]',
  summary: 'observe: capture the TV screen as PNG (--max-width/--jpeg shrink it, --if-changed skips unchanged)',
  flags: [{ name: 'if-changed' }, ...CAPTURE_FLAGS],
  async run(ctx) {
    const [target, ...extra] = ctx.args.positionals;
    if (extra.length > 0) throw usageError('screenshot takes at most one path', 'e.g. agent-atv screenshot ./tv.png');
    const options = captureOptions(ctx, 'agent-atv screenshot --max-width 1280 --jpeg');
    const { device } = await fetchState(ctx);
    const result = await capture(ctx, device.id, target, booleanFlag(ctx.args, 'if-changed'), options);
    if (!result.changed) {
      if (ctx.json) return ctx.printJson({ changed: false, sha256: result.sha256, path: result.path });
      return ctx.print(`unchanged ${result.path}`);
    }
    if (ctx.json) {
      return ctx.printJson({ path: result.path, sha256: result.sha256, width: result.width, height: result.height, changed: true });
    }
    ctx.print(`${result.path} (${result.width}x${result.height}, ${(result.durationMs / 1000).toFixed(1)}s)`);
  },
};
