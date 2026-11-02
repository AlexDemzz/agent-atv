/* eslint-disable @typescript-eslint/no-explicit-any -- tests assert on loosely typed JSON bodies */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgentAtvCore, type AgentAtvCore, type SpawnBridge } from '../../src/core';
import { COMPANION_CREDS, AIRPLAY_CREDS, DEVICE_ID } from './apple-tv';

export interface LogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

export class RecordingLogger {
  readonly lines: LogLine[] = [];
  debug = (message: string) => void this.lines.push({ level: 'debug', message });
  info = (message: string) => void this.lines.push({ level: 'info', message });
  warn = (message: string) => void this.lines.push({ level: 'warn', message });
  error = (message: string) => void this.lines.push({ level: 'error', message });

  at(level: LogLine['level']): string[] {
    return this.lines.filter((l) => l.level === level).map((l) => l.message);
  }

  get text(): string {
    return this.lines.map((l) => `${l.level} ${l.message}`).join('\n');
  }
}

export const TEST_TOKEN = 'test-token-0123456789abcdefghijklmnopqrstuvwxyz';

export interface StartOptions {
  config?: Record<string, unknown>;
  spawnBridge?: SpawnBridge;
  /** A scripted screen worker (test/support/fake-screen.ts). */
  spawnScreen?: SpawnBridge;
  storagePath?: string;
  env?: NodeJS.ProcessEnv;
  /** Defaults to TEST_TOKEN through config.api.token; pass null to use the generated token file. */
  token?: string | null;
  /** When false, returns as soon as the API listens instead of waiting for core.start() to finish. */
  awaitStart?: boolean;
}

export interface ApiResponse<T = any> {
  status: number;
  headers: Headers;
  body: T;
  raw: Buffer;
}

export interface Plugin {
  core: AgentAtvCore;
  log: RecordingLogger;
  storagePath: string;
  url: string;
  token: string;
  request<T = any>(
    method: string,
    pathname: string,
    init?: { body?: unknown; token?: string | null; headers?: Record<string, string>; rawBody?: string },
  ): Promise<ApiResponse<T>>;
  get<T = any>(pathname: string): Promise<ApiResponse<T>>;
  post<T = any>(pathname: string, body?: unknown): Promise<ApiResponse<T>>;
  stop(): Promise<void>;
}

const running = new Set<Plugin>();
const tempDirs: string[] = [];

/** A temp dir removed by removeTempDirs() (and so by stopAll()). */
export async function makeTempDir(prefix = 'agent-atv-test-'): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export const makeStorage = (): Promise<string> => makeTempDir();

export async function removeTempDirs(): Promise<void> {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

export async function seedPairedDevice(
  storagePath: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const dir = path.join(storagePath, 'agent-atv', 'devices');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const record = {
    id: DEVICE_ID,
    name: 'Living Room',
    address: '192.168.1.50',
    mac: 'A1:B2:C3:D4:E5:F6',
    model: 'Apple TV 4K (gen 3)',
    version: '27.2',
    credentials: { companion: COMPANION_CREDS, airplay: AIRPLAY_CREDS },
    pairedAt: '2026-11-01T15:04:05.123Z',
    ...overrides,
  };
  await writeFile(path.join(dir, `${String(record.id)}.json`), JSON.stringify(record), { mode: 0o600 });
}

export async function startPlugin(options: StartOptions = {}): Promise<Plugin> {
  const storagePath = options.storagePath ?? (await makeStorage());
  const log = new RecordingLogger();
  const userConfig = options.config ?? {};
  const userApi = (userConfig.api as Record<string, unknown> | undefined) ?? {};
  const token = options.token === undefined ? TEST_TOKEN : options.token;
  const config = {
    discovery: { enabled: false },
    ...userConfig,
    api: { port: 0, bind: '127.0.0.1', ...(token === null ? {} : { token }), ...userApi },
  };
  const core = createAgentAtvCore({
    config,
    storagePath,
    log,
    pluginVersion: '0.1.0',
    hostname: 'testhost',
    env: options.env ?? { ...process.env, AGENT_ATV_FAKE_BRIDGE: '1' },
    ...(options.spawnBridge ? { spawnBridge: options.spawnBridge } : {}),
    ...(options.spawnScreen ? { spawnScreen: options.spawnScreen } : {}),
  });
  const started = core.start();
  if (options.awaitStart === false) {
    started.catch(() => undefined);
    await eventually(() => core.address());
  } else {
    await started;
  }
  const address = core.address();
  const url = address ? `http://${address.host}:${address.port}` : '';
  let effectiveToken = token ?? '';

  const request: Plugin['request'] = async (method, pathname, init = {}) => {
    const headers: Record<string, string> = { ...init.headers };
    const bearer = init.token === undefined ? effectiveToken : init.token;
    if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
    let body: string | undefined = init.rawBody;
    if (init.body !== undefined) {
      body = JSON.stringify(init.body);
      headers['content-type'] ??= 'application/json';
    }
    const response = await fetch(`${url}/v1${pathname}`, { method, headers, body });
    const raw = Buffer.from(await response.arrayBuffer());
    const type = response.headers.get('content-type') ?? '';
    const parsed = type.startsWith('application/json') && raw.length > 0 ? JSON.parse(raw.toString('utf8')) : null;
    return { status: response.status, headers: response.headers, body: parsed, raw };
  };

  const plugin: Plugin = {
    core,
    log,
    storagePath,
    url,
    get token() {
      return effectiveToken;
    },
    set token(value: string) {
      effectiveToken = value;
    },
    request,
    get: (pathname) => request('GET', pathname),
    post: (pathname, body = {}) => request('POST', pathname, { body }),
    stop: async () => {
      running.delete(plugin);
      await core.stop();
    },
  };
  running.add(plugin);
  return plugin;
}

export async function stopAll(): Promise<void> {
  await Promise.all([...running].map((p) => p.stop()));
  await removeTempDirs();
}

/** Polls `check` until it returns a truthy value or throws after `timeoutMs`. */
export async function eventually<T>(check: () => Promise<T> | T, timeoutMs = 3000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value) return value as NonNullable<T>;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) {
      throw lastError instanceof Error ? lastError : new Error('condition not met in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export async function waitConnected(plugin: Plugin, device = DEVICE_ID): Promise<void> {
  await eventually(async () => (await plugin.get(`/devices/${device}/state`)).body?.connection === 'connected');
}
