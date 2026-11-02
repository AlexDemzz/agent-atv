import { createHash, randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ApiError, toApiError } from '../api/errors';
import { BridgeClient, BridgeError, type SpawnBridge, type SpawnSpec } from '../bridge/client';
import type { App, Json } from '../bridge/protocol';
import type { Device, DeviceManager } from '../devices/manager';
import { ensureDir } from '../fs-util';
import { errorMessage, type Logger } from '../logger';
import { jpegSize, pngSize } from './image-size';

export interface FocusElement {
  label: string | null;
  value: string | null;
  identifier: string | null;
}

/** Why a report has no answer: a screen error, with the hint that fixes it. */
export interface Unavailable {
  available: false;
  code: string;
  reason: string;
  hint: string;
}

/** What actions, `state?focus=1` and wait return about the focused element; never an error. */
export type FocusReport = { available: true; element: FocusElement } | Unavailable;

/** What tvOS shows, from the worker's `foreground` read (DESIGN.md §6.2). */
export type Foreground =
  | ({ kind: 'app' } & App)
  | { kind: 'home' }
  | { kind: 'screensaver' }
  | { kind: 'ambiguous'; apps: App[] };

/** What `state?app=1` and `open` return about the foreground app; never an error. */
export type AppReport = ({ available: true } & Foreground) | Unavailable;

/** A focus read, with when tvOS reported that focus move (epoch ms, this process's clock). */
export interface FocusRead {
  element: FocusElement;
  movedAtMs: number;
}

export type Tunnel = 'unpaired' | 'connecting' | 'connected' | 'disconnected';
export type ScreenStatus = 'disabled' | 'installing' | 'ready' | 'error';
/** DeviceSummary.screen: `off` while screen reading is off or not installed. */
export type DeviceScreen = 'off' | 'starting' | Tunnel;

export interface WorkerReady {
  protocolVersion: number;
  workerVersion: string;
  python: string | null;
  pymobiledevice3: string | null;
  backend: 'pmd3' | 'fake';
}

interface WorkerStatus {
  tunnel: Tunnel;
  identifier: string | null;
  error: string | null;
}

interface Worker {
  client: BridgeClient<WorkerReady>;
  spec: SpawnSpec;
  status: WorkerStatus | null;
  /** The last tunnel state logged at info. */
  announced: Tunnel | null;
}

export type ImageFormat = 'png' | 'jpeg';

export interface CaptureOptions {
  /** Scales the capture down to this width, keeping its aspect ratio; never up. */
  maxWidth?: number;
  format?: ImageFormat;
}

export interface Capture {
  image: Buffer;
  format: ImageFormat;
  sha256: string;
  width: number;
  height: number;
  capturedAt: string;
  durationMs: number;
}

export type CaptureResult = ({ changed: true } & Capture) | { changed: false; sha256: string };

export interface ScreenInfo {
  enabled: boolean;
  status: ScreenStatus;
  ready: boolean;
  reason: string | null;
  pymobiledevice3: string | null;
}

const SECOND = 1000;
// The worker itself bounds a read to a tunnel reconnect (30 s) plus two attempts (20 s each).
const TIMEOUTS: Record<string, number> = {
  ping: 5 * SECOND,
  focus: 90 * SECOND,
  foreground: 90 * SECOND,
  screenshot: 110 * SECOND,
  'pair.begin': 70 * SECOND,
  'pair.pin': 40 * SECOND,
};
const DEFAULT_TIMEOUT_MS = 10 * SECOND;
const READY_WAIT_MS = 20 * SECOND;
/** The worker learns a focus move about 50 ms after the key; a focus read takes about 0.2 s on a Pi. */
const SETTLE_MS = 300;
const SETTLE_CAP_MS = 1000;
/** A read that has to reopen the worker's accessibility session takes 0.4 to 0.6 s on a Pi. */
const FIRST_READ_MS = 1000;
/** Between settle reads that found the focus unknown or not moved yet. */
const SETTLE_RETRY_MS = 100;
const REPORT_READ_MS = 5000;
const IDENTIFIER = /^[A-Za-z0-9-]+$/;

const SCRUBBED_ENV = new Set(['XDG_DATA_HOME', 'SUDO_USER', 'SUDO_UID', 'SUDO_GID']);

const REASONS: Record<string, string> = {
  SCREEN_NOT_CONFIGURED: 'screen reading off',
  SCREEN_NOT_PAIRED: 'screen reading not paired',
  SCREEN_UNAVAILABLE: 'screen reading not connected',
  FOCUS_UNKNOWN: 'focus not known',
  DEVICE_OFF: 'Apple TV off',
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const sameElement = (a: FocusElement, b: FocusElement): boolean => JSON.stringify(a) === JSON.stringify(b);

export const isFocusUnknown = (error: unknown): error is ApiError => error instanceof ApiError && error.code === 'FOCUS_UNKNOWN';

/** Screen reading (DESIGN.md §6): one long-lived screen worker per Apple TV, holding its tunnel. */
export class ScreenService {
  status: ScreenStatus;
  private error: string | null = null;
  private python: string;
  private readonly workers = new Map<string, Worker>();
  private stopped = false;
  private isEnabled: boolean;
  private started = false;

  constructor(
    private readonly options: {
      enabled: boolean;
      pluginDir: string;
      pythonDir: string;
      devices: DeviceManager;
      log: Logger;
      env: NodeJS.ProcessEnv;
      spawn: SpawnBridge;
      /** The interpreter until the venv is ready: python.executable. */
      python: string;
      fake: boolean;
      /** Builds the screen venv (DESIGN.md §5.2) and returns its interpreter. */
      install: () => Promise<string>;
    },
  ) {
    this.isEnabled = options.enabled;
    this.status = options.enabled ? 'installing' : 'disabled';
    this.python = options.python;
    options.devices.screenStatus = (device) => this.screenOf(device);
  }

  get enabled(): boolean {
    return this.isEnabled;
  }

  /** In the background: installs the screen venv, then starts the workers; a failure leaves the status `error`. */
  start(): void {
    if (this.started || !this.isEnabled) return;
    this.started = true;
    this.install().catch((error: unknown) => this.options.log.error(`Screen reading failed to start: ${errorMessage(error)}`));
  }

  private async install(): Promise<void> {
    let python: string;
    try {
      python = await this.options.install();
    } catch (error) {
      this.fail(errorMessage(error));
      this.options.log.error(`Screen reading is unavailable: ${errorMessage(error)}`);
      return;
    }
    await this.ready(python);
  }

  /** Turns screen reading on in the running plugin; the settings UI saves it to the config. */
  enable(): void {
    if (this.isEnabled) return;
    this.isEnabled = true;
    this.status = 'installing';
    this.start();
  }

  private get pmd3Home(): string {
    return path.join(this.options.pluginDir, 'pmd3-home');
  }

  /** The screen venv is ready: start a worker for every paired Apple TV. */
  private async ready(python: string): Promise<void> {
    if (this.stopped) return;
    this.python = python;
    await ensureDir(this.pmd3Home);
    this.status = 'ready';
    for (const device of this.options.devices.all()) {
      if (this.options.devices.isPaired(device)) this.workerFor(device);
    }
  }

  private fail(message: string): void {
    this.status = 'error';
    this.error = message;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const workers = [...this.workers.values()];
    this.workers.clear();
    await Promise.all(
      workers.map((worker) =>
        worker.client.stop().catch((error: unknown) => this.options.log.error(`Stopping a screen worker failed: ${errorMessage(error)}`)),
      ),
    );
  }

  async info(): Promise<ScreenInfo> {
    const workers = [...this.workers.values()];
    const connected = workers.some((w) => w.status?.tunnel === 'connected');
    const version = workers.map((w) => w.client.info?.pymobiledevice3).find((v) => v) ?? null;
    let reason: string | null = null;
    if (this.status === 'disabled') reason = 'screen.enabled is off';
    else if (this.status === 'installing') reason = 'installing pymobiledevice3 (about 2 minutes on first start)';
    else if (this.status === 'error') reason = this.error;
    else if (!connected) reason = 'no Apple TV has screen reading connected';
    return { enabled: this.enabled, status: this.status, ready: this.status === 'ready' && connected, reason, pymobiledevice3: version };
  }

  screenOf(device: Device): DeviceScreen {
    if (this.status !== 'ready') return 'off';
    return this.workers.get(device.id)?.status?.tunnel ?? 'starting';
  }

  async focus(device: Device): Promise<{ focus: FocusElement; durationMs: number }> {
    const started = Date.now();
    const { element } = await this.read(device);
    return { focus: element, durationMs: Date.now() - started };
  }

  async read(device: Device): Promise<FocusRead> {
    const sentAt = Date.now();
    const { focus, ageMs } = await this.request<{ focus: FocusElement; ageMs: number }>(device, 'focus');
    // From the send time, the move can only come out earlier than it was: towards unknown.
    const read = { element: focus, movedAtMs: sentAt - ageMs };
    if (!this.isCurrent(device, read)) {
      throw new ApiError('FOCUS_UNKNOWN', `The app or playback on ${this.options.devices.displayName(device)} changed after the focus last moved`, {});
    }
    return read;
  }

  /** False once the app or playback changed after the move: the screen did too. */
  isCurrent(device: Device, read: FocusRead): boolean {
    return read.movedAtMs >= device.screenChangedAtMs;
  }

  /**
   * The focused element, as a report that never throws. Only uses a tunnel that is already up, so
   * an unpaired or reconnecting screen costs the action nothing. With `settle` (after an action),
   * see settled(); `movedSince` then rejects a focus tvOS reported before the action.
   */
  async report(device: Device, { settle, movedSince }: { settle: boolean; movedSince?: number }): Promise<FocusReport> {
    try {
      this.requireTunnel(device);
      const element = settle ? await this.settled(device, movedSince) : (await this.readWithin(device, REPORT_READ_MS)).element;
      return { available: true, element };
    } catch (error) {
      return this.unavailable(device, error, 'focus read failed');
    }
  }

  /** What tvOS shows; throws the screen errors, `SCREEN_UNAVAILABLE` for a read longer than `withinMs`. */
  async foreground(device: Device, withinMs?: number): Promise<Foreground> {
    const read = this.request<Foreground>(device, 'foreground');
    return withinMs === undefined ? read : this.within(device, read, withinMs, 'foreground');
  }

  /** The foreground app, as a report that never throws; like report(), only over a tunnel already up. */
  async appReport(device: Device, withinMs = REPORT_READ_MS): Promise<AppReport> {
    try {
      this.requireTunnel(device);
      return { available: true, ...(await this.foreground(device, Math.min(withinMs, REPORT_READ_MS))) };
    } catch (error) {
      return this.unavailable(device, error, 'foreground read failed');
    }
  }

  private requireTunnel(device: Device): void {
    this.precheck(device);
    const tunnel = this.workerFor(device).status?.tunnel;
    if (tunnel !== 'connected') throw this.tunnelError(device, tunnel ?? 'connecting');
  }

  private unavailable(device: Device, error: unknown, failed: string): Unavailable {
    const apiError = toApiError(error, this.options.devices.displayName(device));
    const reason = apiError.code === 'SCREEN_FAILED' ? failed : (REASONS[apiError.code] ?? apiError.message);
    return { available: false, code: apiError.code, reason, hint: apiError.hint };
  }

  /**
   * Waits SETTLE_MS, then reads until two reads agree or SETTLE_CAP_MS passed. A read that finds
   * the focus unknown, or not moved since `movedSince`, is retried within that window and drops
   * the reads before it: they may show an earlier screen.
   */
  private async settled(device: Device, movedSince: number | undefined): Promise<FocusElement> {
    const deadline = Date.now() + SETTLE_CAP_MS;
    await sleep(SETTLE_MS);
    let last: FocusRead | undefined;
    let notKnown = new ApiError('FOCUS_UNKNOWN', `${this.options.devices.displayName(device)} reported no focus move after the action`, {});
    for (let first = true; first || Date.now() < deadline; first = false) {
      let read: FocusRead;
      try {
        read = await this.readWithin(device, first ? Math.max(FIRST_READ_MS, deadline - Date.now()) : deadline - Date.now());
      } catch (error) {
        if (!isFocusUnknown(error)) {
          if (first) throw error;
          break;
        }
        [notKnown, last] = [error, undefined];
        await sleep(SETTLE_RETRY_MS);
        continue;
      }
      if (movedSince !== undefined && read.movedAtMs < movedSince) {
        last = undefined;
        await sleep(SETTLE_RETRY_MS);
        continue;
      }
      if (last && sameElement(last.element, read.element)) return read.element;
      last = read;
    }
    if (last) return last.element;
    throw notKnown;
  }

  private readWithin(device: Device, ms: number): Promise<FocusRead> {
    return this.within(device, this.read(device), ms, 'focus');
  }

  private within<T>(device: Device, read: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new ApiError('SCREEN_UNAVAILABLE', `${this.options.devices.displayName(device)} did not answer the ${what} read within ${ms}ms`, {}, {
              hint: 'retry in a few seconds',
            }),
          ),
        Math.max(1, ms),
      );
    });
    return Promise.race([read, timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * Captures one screenshot through the device's worker (one at a time per device). The sha256 is
   * of the bytes returned, so `ifNoneMatch` only matches a capture taken with the same options.
   */
  async capture(device: Device, ifNoneMatch: string | undefined, { maxWidth, format = 'png' }: CaptureOptions = {}): Promise<CaptureResult> {
    const started = Date.now();
    const out = path.join(tmpdir(), `agent-atv-${randomBytes(8).toString('hex')}.${format === 'jpeg' ? 'jpg' : 'png'}`);
    try {
      await this.request(device, 'screenshot', { path: out, format, ...(maxWidth === undefined ? {} : { maxWidth }) });
      const image = await readFile(out);
      const size = format === 'jpeg' ? jpegSize(image) : pngSize(image);
      if (!size) throw new ApiError('SCREEN_FAILED', `The Apple TV sent something that is not a ${format.toUpperCase()}`, {});
      const sha256 = createHash('sha256').update(image).digest('hex');
      if (ifNoneMatch === sha256) return { changed: false, sha256 };
      return { changed: true, image, format, sha256, ...size, capturedAt: new Date().toISOString(), durationMs: Date.now() - started };
    } finally {
      await rm(out, { force: true });
    }
  }

  async pairBegin(device: Device): Promise<void> {
    await this.request(device, 'pair.begin', {}, { checkPower: false });
  }

  /** Submits the RemotePairing PIN and remembers which pair record belongs to the device. */
  async pairPin(device: Device, pin: string): Promise<void> {
    const { identifier } = await this.request<{ identifier: string }>(device, 'pair.pin', { pin }, { checkPower: false });
    await this.remember(device, identifier);
  }

  async pairCancel(device: Device): Promise<void> {
    const worker = this.workers.get(device.id);
    if (worker?.client.status !== 'ready') return;
    await worker.client.request('pair.cancel').catch((error: unknown) => this.options.log.debug(`pair.cancel failed: ${errorMessage(error)}`));
  }

  /**
   * Deletes the device's pair record before anything else, so a worker spawned meanwhile finds
   * nothing to reconnect with, then stops its worker. Works with screen reading off too.
   */
  async forget(device: Device): Promise<void> {
    const worker = this.workers.get(device.id);
    const identifier = device.record?.remotePairing?.identifier ?? worker?.status?.identifier ?? null;
    if (identifier !== null && IDENTIFIER.test(identifier)) {
      // pymobiledevice3 keeps records in the XDG folder, or in the legacy one when that exists.
      for (const folder of [path.join('.local', 'share', 'pymobiledevice3'), '.pymobiledevice3']) {
        await rm(path.join(this.pmd3Home, folder, `remote_${identifier}.plist`), { force: true });
      }
    }
    await this.options.devices.setRemotePairing(device, null);
    if (worker) {
      this.workers.delete(device.id);
      await worker.client.stop().catch((error: unknown) => this.options.log.debug(`Stopping a screen worker failed: ${errorMessage(error)}`));
    }
  }

  private precheck(device: Device, checkPower = true): void {
    const id = device.id;
    if (!this.enabled) {
      throw new ApiError('SCREEN_NOT_CONFIGURED', 'Screen reading is off in the plugin settings', {});
    }
    if (this.status === 'installing') {
      throw new ApiError('SCREEN_UNAVAILABLE', 'Screen reading is still being installed', { status: this.status }, {
        hint: 'retry in a minute (the first install takes about 2 minutes)',
      });
    }
    if (this.status === 'error') {
      throw new ApiError('SCREEN_NOT_CONFIGURED', `Screen reading could not be installed: ${this.error ?? 'unknown error'}`, { status: this.status }, {
        hint: 'ask the user to fix the install error shown in the Homebridge log, then restart Homebridge',
      });
    }
    if (checkPower && device.state.power === 'off') {
      throw new ApiError('DEVICE_OFF', `${this.options.devices.displayName(device)} is off`, { device: id }, {
        hint: 'turn it on: agent-atv power on',
      });
    }
  }

  private tunnelError(device: Device, tunnel: Tunnel): ApiError {
    if (tunnel === 'unpaired') return this.notPaired(device);
    return new ApiError('SCREEN_UNAVAILABLE', `Screen reading on ${this.options.devices.displayName(device)} is ${tunnel}`, { tunnel }, {
      hint: 'retry in a few seconds',
    });
  }

  private notPaired(device: Device): ApiError {
    return new ApiError('SCREEN_NOT_PAIRED', `Screen reading is not paired on ${this.options.devices.displayName(device)}`, { device: device.id }, {
      hint: `run agent-atv pair ${device.id} --screen`,
    });
  }

  private async request<T = Json>(device: Device, method: string, params: Json = {}, { checkPower = true } = {}): Promise<T> {
    this.precheck(device, checkPower);
    const worker = this.workerFor(device);
    if (!(await worker.client.waitReady(READY_WAIT_MS))) {
      throw new ApiError('SCREEN_UNAVAILABLE', 'The screen worker is not ready', { status: worker.client.status }, {
        hint: 'retry in a few seconds; if it persists, check the Homebridge log',
      });
    }
    try {
      return await worker.client.request<T>(method, params);
    } catch (error) {
      throw this.mapError(device, error);
    }
  }

  private mapError(device: Device, error: unknown): ApiError {
    if (!(error instanceof BridgeError)) return toApiError(error, this.options.devices.displayName(device));
    const name = this.options.devices.displayName(device);
    switch (error.code) {
      case 'SCREEN_NOT_PAIRED':
        return this.notPaired(device);
      case 'SCREEN_UNAVAILABLE':
        return new ApiError('SCREEN_UNAVAILABLE', `${name}: ${error.message}`, error.details, {
          hint: 'wake the Apple TV with agent-atv power on, then retry',
        });
      case 'BRIDGE_UNAVAILABLE':
        return new ApiError('SCREEN_UNAVAILABLE', `The screen worker for ${name} is restarting`, error.details, { hint: 'retry in a few seconds' });
      case 'BRIDGE_TIMEOUT':
        return new ApiError('SCREEN_FAILED', `The screen worker for ${name} did not answer in time`, error.details);
      case 'PAIRING_FAILED':
        return new ApiError('PAIRING_FAILED', error.message, error.details, {
          hint: `on the Apple TV open Settings > Remotes and Devices > Remote App and Devices, then run agent-atv pair ${device.id} --screen`,
        });
      default:
        return toApiError(error, name);
    }
  }

  private workerFor(device: Device): Worker {
    const existing = this.workers.get(device.id);
    if (existing) return existing;
    const spec: SpawnSpec = { command: this.python, args: this.argsFor(device), cwd: this.options.pythonDir, env: this.childEnv() };
    const name = this.options.devices.displayName(device);
    const client = new BridgeClient<WorkerReady>({
      spawn: this.options.spawn,
      spec,
      log: this.options.log,
      label: `screen worker for ${name}`,
      logPrefix: `screen ${name}`,
      // The worker logs status changes at INFO, the rest at DEBUG (DESIGN.md §6.2).
      infoLevel: 'info',
      timeoutFor: (method) => TIMEOUTS[method] ?? DEFAULT_TIMEOUT_MS,
      describeReady: (ready) => `${name}: screen worker ready (${ready?.backend ?? '?'}, pymobiledevice3 ${ready?.pymobiledevice3 ?? 'n/a'})`,
    });
    const worker: Worker = { client, spec, status: null, announced: null };
    client.on('exit', () => {
      worker.status = null;
      // The restart picks up a new address (DHCP) or pair record.
      spec.args = this.argsFor(device);
    });
    client.on('event', (event, _device, data) => {
      if (event === 'status') this.onStatus(device, worker, data as WorkerStatus);
    });
    this.workers.set(device.id, worker);
    client.start();
    return worker;
  }

  private onStatus(device: Device, worker: Worker, status: WorkerStatus): void {
    const previous = worker.status;
    worker.status = status;
    const name = this.options.devices.displayName(device);
    if (status.tunnel !== previous?.tunnel) this.announce(device, worker, status);
    if (status.identifier && status.identifier !== device.record?.remotePairing?.identifier) {
      this.remember(device, status.identifier).catch((error: unknown) =>
        this.options.log.error(`${name}: cannot save the RemotePairing identifier: ${errorMessage(error)}`),
      );
    }
  }

  /**
   * Tunnel changes at info, so a field failure shows in the normal log; while a reconnect keeps
   * failing (every 2 to 60 s), only its first failure.
   */
  private announce(device: Device, worker: Worker, status: WorkerStatus): void {
    const name = this.options.devices.displayName(device);
    const detail = status.error ? ` (${status.error})` : '';
    const retrying = status.tunnel === 'connecting' && worker.announced === 'disconnected';
    if (status.tunnel === worker.announced || retrying) {
      this.options.log.debug(`${name}: screen reading ${status.tunnel}${detail}`);
      return;
    }
    const lines: Record<Tunnel, string> = {
      connected: 'connected',
      connecting: worker.announced === 'connected' ? 'reconnecting' : 'connecting',
      disconnected: `disconnected${detail}; retrying with backoff`,
      unpaired: `not paired${detail}; pair it with agent-atv pair ${device.id} --screen`,
    };
    worker.announced = status.tunnel;
    this.options.log.info(`${name}: screen reading ${lines[status.tunnel]}`);
  }

  private async remember(device: Device, identifier: string): Promise<void> {
    await this.options.devices.setRemotePairing(device, identifier);
    const worker = this.workers.get(device.id);
    if (worker) worker.spec.args = this.argsFor(device);
  }

  private argsFor(device: Device): string[] {
    const args = ['-u', '-m', 'agent_atv_screen'];
    if (this.options.fake) args.push('--fake');
    const address = this.options.devices.address(device);
    if (address) args.push('--address', address);
    const identifier = device.record?.remotePairing?.identifier;
    if (identifier) args.push('--identifier', identifier);
    return args;
  }

  private childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(this.options.env)) {
      if (value === undefined || SCRUBBED_ENV.has(key) || key.startsWith('PYMOBILEDEVICE3_')) continue;
      env[key] = value;
    }
    env.HOME = this.pmd3Home;
    env.PYTHONPATH = this.options.pythonDir;
    return env;
  }
}
