import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { SpawnBridge } from '../../src/core';

export type Params = Record<string, unknown>;
export type Handler = (params: Params) => unknown;

export class BridgeFailure extends Error {
  constructor(
    readonly code: string,
    message: string = code,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Returned by a handler to leave the request unanswered. */
export const NO_RESPONSE = Symbol('no-response');

export interface SpawnRecord {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface RecordedRequest {
  id: number;
  method: string;
  params: Params;
  at: number;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid: number;
  exited = false;
  private buffer = '';

  constructor(
    pid: number,
    private readonly onRequest: (proc: FakeProcess, line: string) => void,
  ) {
    super();
    this.pid = pid;
    this.stdin.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let index: number;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (line.trim()) this.onRequest(this, line);
      }
    });
  }

  send(message: unknown): void {
    if (!this.exited) this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    setImmediate(() => {
      this.stdout.end();
      this.stderr.end();
      this.emit('exit', code, signal);
      this.emit('close', code, signal);
    });
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    this.exit(null, typeof signal === 'number' ? 'SIGKILL' : signal);
    return true;
  }
}

/**
 * A scripted stand-in for the Python bridge process, injected through CoreOptions.spawnBridge.
 * It speaks the JSON-lines protocol of DESIGN.md §2; handlers script the responses.
 */
export class FakeBridge {
  readonly spawns: SpawnRecord[] = [];
  readonly requests: RecordedRequest[] = [];
  readonly kills: (NodeJS.Signals | number | undefined)[] = [];
  readyEvent: Record<string, unknown> = {
    protocolVersion: 1,
    bridgeVersion: '0.1.0',
    python: '3.11.2',
    pyatv: null,
    backend: 'fake',
  };
  /** When false, the next spawned processes never send `ready`. */
  sendsReady = true;
  /** Messages each new process sends right after `ready`. */
  afterReady: () => unknown[] = () => [];
  private readonly handlers = new Map<string, Handler>();
  private process: FakeProcess | undefined;

  constructor() {
    this.handle('ping', () => ({ pong: true }));
    this.handle('scan', () => ({ devices: [] }));
    this.handle('disconnect', () => ({}));
    this.handle('pair.cancel', () => ({}));
  }

  readonly spawn: SpawnBridge = (spec) => {
    this.spawns.push({ ...spec, args: [...spec.args] });
    const proc = new FakeProcess(this.spawns.length + 1000, (p, line) => void this.dispatch(p, line));
    const kill = proc.kill.bind(proc);
    proc.kill = (signal?: NodeJS.Signals | number) => {
      this.kills.push(signal);
      return kill(signal);
    };
    this.process = proc;
    if (this.sendsReady) {
      setImmediate(() => {
        proc.send({ event: 'ready', data: this.readyEvent });
        for (const message of this.afterReady()) proc.send(message);
      });
    }
    return proc as unknown as ReturnType<SpawnBridge>;
  };

  handle(method: string, handler: Handler): this {
    this.handlers.set(method, handler);
    return this;
  }

  /** Requests received for a method, oldest first. */
  calls(method: string): Params[] {
    return this.requests.filter((r) => r.method === method).map((r) => r.params);
  }

  event(event: string, device: string | undefined, data: unknown): void {
    this.current().send(device === undefined ? { event, data } : { event, device, data });
  }

  writeRaw(text: string): void {
    this.current().stdout.write(text);
  }

  logStderr(line: string): void {
    this.current().stderr.write(`${line}\n`);
  }

  crash(code = 1): void {
    this.current().exit(code);
  }

  get running(): boolean {
    return this.process !== undefined && !this.process.exited;
  }

  private current(): FakeProcess {
    if (!this.process) throw new Error('the bridge was never spawned');
    return this.process;
  }

  private async dispatch(proc: FakeProcess, line: string): Promise<void> {
    const request = JSON.parse(line) as { id: number; method: string; params: Params };
    this.requests.push({ ...request, at: Date.now() });
    if (request.method === 'shutdown') {
      proc.send({ id: request.id, ok: true, result: {} });
      proc.exit(0);
      return;
    }
    const handler = this.handlers.get(request.method);
    if (!handler) {
      proc.send({
        id: request.id,
        ok: false,
        error: { code: 'UNKNOWN_METHOD', message: request.method, details: { method: request.method } },
      });
      return;
    }
    try {
      const result = await handler(request.params);
      if (result === NO_RESPONSE) return;
      proc.send({ id: request.id, ok: true, result });
    } catch (error) {
      if (error instanceof BridgeFailure) {
        proc.send({
          id: request.id,
          ok: false,
          error: { code: error.code, message: error.message, details: error.details },
        });
      } else {
        proc.send({ id: request.id, ok: false, error: { code: 'INTERNAL', message: String(error), details: {} } });
      }
    }
  }
}

export { delay };
