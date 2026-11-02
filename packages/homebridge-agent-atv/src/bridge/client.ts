import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Logger } from '../logger';
import { errorMessage } from '../logger';
import {
  LineSplitter,
  MAX_LINE_BYTES,
  methodTimeoutMs,
  parseMessage,
  type ConnectionEvent,
  type BridgeState,
  type Json,
  type ReadyEvent,
} from './protocol';

export type BridgeProcess = Pick<ChildProcessWithoutNullStreams, 'stdin' | 'stdout' | 'stderr' | 'kill' | 'on' | 'once' | 'pid'>;
export interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}
export type SpawnBridge = (spec: SpawnSpec) => BridgeProcess;

export type BridgeStatus = 'starting' | 'installing' | 'ready' | 'restarting' | 'error';

export const defaultSpawnBridge: SpawnBridge = (spec) =>
  spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: 'pipe' });

/** A failure reported by the bridge, or by the plugin side of the bridge link. */
export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Json = {},
  ) {
    super(message);
  }
}

interface Pending {
  method: string;
  resolve: (result: Json) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface BridgeEvents<Ready> {
  ready: [Ready];
  state: [string, BridgeState];
  connection: [string, ConnectionEvent];
  /** Every event except `ready`, as sent. */
  event: [string, string | undefined, unknown];
  exit: [];
}

export interface BridgeClientOptions<Ready> {
  spawn: SpawnBridge;
  spec: SpawnSpec;
  log: Logger;
  /** Names the child process in logs; default "Python bridge". */
  label?: string;
  /** Prefix of the child's forwarded stderr lines; default "bridge". */
  logPrefix?: string;
  /** Plugin-side request timeouts; default DESIGN.md §2.4. */
  timeoutFor?: (method: string, params: Json) => number;
  /** The log line for a `ready` event. */
  describeReady?: (ready: Ready | null) => string;
}

const describeBridgeReady = (info: ReadyEvent | null) =>
  `Python bridge ready (backend ${info?.backend ?? '?'}, python ${info?.python ?? '?'}, pyatv ${info?.pyatv ?? 'n/a'})`;

const READY_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 5_000;
const BACKOFF_MAX_S = 60;
const BACKOFF_RESET_UPTIME_MS = 5 * 60_000;

/**
 * Spawns and supervises a JSON-lines Python child (the bridge, DESIGN.md §2, §5.1, or a screen
 * worker, §6.2), and matches requests to responses.
 */
export class BridgeClient<Ready extends object = ReadyEvent> extends EventEmitter<BridgeEvents<Ready>> {
  status: BridgeStatus = 'starting';
  error: string | null = null;
  info: Ready | null = null;

  private child: BridgeProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private restartAttempt = 0;
  private spawnedAt = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private readyTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private readyWaiters: (() => void)[] = [];

  private readonly label: string;

  constructor(private readonly options: BridgeClientOptions<Ready>) {
    super();
    this.label = options.label ?? 'Python bridge';
  }

  /** Marks the bridge as not startable (venv bootstrap failed). */
  fail(message: string): void {
    this.status = 'error';
    this.error = message;
  }

  /** Replaces the interpreter, once the venv is ready. */
  setCommand(command: string): void {
    this.options.spec.command = command;
  }

  setInstalling(): void {
    this.status = 'installing';
  }

  start(): void {
    this.stopping = false;
    this.spawnChild();
  }

  /** Resolves true once `ready` arrives, false after `timeoutMs`. */
  waitReady(timeoutMs = READY_TIMEOUT_MS): Promise<boolean> {
    if (this.status === 'ready') return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w !== done);
        resolve(false);
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.readyWaiters.push(done);
    });
  }

  request<T = Json>(method: string, params: Json = {}): Promise<T> {
    const child = this.child;
    if (this.status !== 'ready' || !child) {
      return Promise.reject(this.unavailable());
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = (this.options.timeoutFor ?? methodTimeoutMs)(method, params);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError('BRIDGE_TIMEOUT', `The ${this.label} did not answer ${method} within ${timeoutMs}ms`, { method, timeoutMs }));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolve as (r: Json) => void, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new BridgeError('BRIDGE_UNAVAILABLE', `Cannot write to the ${this.label}: ${errorMessage(error)}`, { status: this.status }));
      }
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.restartTimer = null;
    this.readyTimer = null;
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    if (this.status === 'ready') {
      this.request('shutdown').catch(() => undefined);
    } else {
      child.kill('SIGTERM');
    }
    const killTimer = setTimeout(() => child.kill('SIGKILL'), SHUTDOWN_GRACE_MS);
    await exited;
    clearTimeout(killTimer);
  }

  private unavailable(): BridgeError {
    const details: Json = { status: this.status };
    if (this.error) details.error = this.error;
    return new BridgeError('BRIDGE_UNAVAILABLE', `The ${this.label} is not ready (${this.status})`, details);
  }

  private spawnChild(): void {
    const { spawn: spawnBridge, spec, log } = this.options;
    let child: BridgeProcess;
    try {
      child = spawnBridge(spec);
    } catch (error) {
      log.error(`Cannot start the ${this.label} (${spec.command}): ${errorMessage(error)}`);
      this.error = errorMessage(error);
      this.scheduleRestart();
      return;
    }
    this.child = child;
    this.spawnedAt = Date.now();
    if (this.status !== 'restarting') this.status = 'starting';

    const stdout = new LineSplitter(
      (line) => this.onLine(line),
      () => log.error(`Dropped a ${this.label} message longer than ${MAX_LINE_BYTES} bytes`),
    );
    const stderr = new LineSplitter(
      (line) => this.onStderr(line),
      () => log.warn(`Dropped an overlong ${this.label} log line`),
    );
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on('error', (error) => log.debug(`bridge stdin: ${error.message}`));
    child.stdout.on('error', (error) => log.debug(`bridge stdout: ${error.message}`));
    child.stderr.on('error', (error) => log.debug(`bridge stderr: ${error.message}`));

    let gone = false;
    const onGone = (description: string) => {
      if (gone) return;
      gone = true;
      this.onExit(child, description);
    };
    child.on('error', (error: Error) => {
      log.error(`${this.label} process error (${spec.command}): ${error.message}`);
      this.error = error.message;
      onGone(error.message);
    });
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      onGone(signal ? `signal ${signal}` : `code ${String(code)}`);
    });

    this.readyTimer = setTimeout(() => {
      if (this.child === child && this.status !== 'ready') {
        log.error(`The ${this.label} sent no ready event within ${READY_TIMEOUT_MS / 1000}s; restarting it`);
        child.kill('SIGKILL');
      }
    }, READY_TIMEOUT_MS);
  }

  private onExit(child: BridgeProcess, description: string): void {
    if (this.child !== child) return;
    this.child = null;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new BridgeError('BRIDGE_UNAVAILABLE', `The ${this.label} exited during ${pending.method}`, { status: 'restarting' }));
      this.pending.delete(id);
    }
    if (this.stopping) return;
    this.options.log.error(`The ${this.label} exited unexpectedly (${description}); restarting it`);
    this.emit('exit');
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.stopping) return;
    if (Date.now() - this.spawnedAt >= BACKOFF_RESET_UPTIME_MS) this.restartAttempt = 0;
    const delayS = Math.min(BACKOFF_MAX_S, 2 ** this.restartAttempt);
    this.restartAttempt += 1;
    this.status = 'restarting';
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping) this.spawnChild();
    }, delayS * 1000);
  }

  private onLine(line: string): void {
    const message = parseMessage(line);
    const log = this.options.log;
    if (!message) {
      log.error(`Ignored an invalid line from the ${this.label}: ${line.slice(0, 200)}`);
      return;
    }
    if (message.kind === 'event') {
      try {
        this.onEvent(message.event, message.device, message.data);
      } catch (error) {
        log.error(`Handling the ${this.label} ${message.event} event failed: ${errorMessage(error)}`);
      }
      return;
    }
    if (message.id === null) {
      if (!message.ok) log.error(`${this.label} error without a request id: ${message.error.code} ${message.error.message}`);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      log.debug(`Dropped a late ${this.label} response (id ${message.id})`);
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new BridgeError(message.error.code, message.error.message, message.error.details ?? {}));
  }

  private onEvent(event: string, device: string | undefined, data: unknown): void {
    if (event === 'ready') {
      if (this.readyTimer) clearTimeout(this.readyTimer);
      this.info = data && typeof data === 'object' ? (data as Ready) : null;
      this.status = 'ready';
      this.error = null;
      const describe = this.options.describeReady ?? (describeBridgeReady as unknown as (ready: Ready | null) => string);
      this.options.log.info(describe(this.info));
      const waiters = this.readyWaiters;
      this.readyWaiters = [];
      waiters.forEach((w) => w());
      this.emit('ready', this.info as Ready);
      return;
    }
    this.emit('event', event, device, data);
    if (!device) return;
    if (event === 'state') this.emit('state', device, data as BridgeState);
    else if (event === 'connection') this.emit('connection', device, data as ConnectionEvent);
  }

  private onStderr(line: string): void {
    const log = this.options.log;
    const match = /^(DEBUG|INFO|WARNING|ERROR)\s+(.*)$/.exec(line);
    const level = match?.[1];
    const text = `${this.options.logPrefix ?? 'bridge'}: ${match?.[2] ?? line}`;
    if (level === 'ERROR') log.error(text);
    else if (level === 'WARNING') log.warn(text);
    else log.debug(text);
  }
}
