import { AtvError } from './errors.js';
import { EXIT } from './exit-codes.js';
import { VERSION } from './version.js';

export interface RequestOptions {
  body?: unknown;
  timeoutMs?: number;
  auth?: boolean;
}

export class ApiClient {
  constructor(
    readonly baseUrl: string,
    private readonly token: string | undefined,
    readonly timeoutMs: number,
  ) {}

  async json<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.raw(method, path, options);
    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AtvError('HTTP_ERROR', `Unexpected non-JSON response from ${this.baseUrl} (HTTP ${response.status})`, {
        hint: `Check that ${this.baseUrl} is the homebridge-agent-atv API. Try: agent-atv doctor`,
        status: response.status,
      });
    }
  }

  /** Resolves for 2xx and 304; throws AtvError for everything else. */
  async raw(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': `agent-atv/${VERSION}` };
    if (options.auth !== false && this.token !== undefined) headers.authorization = `Bearer ${this.token}`;
    let body: string | undefined;
    if (method !== 'GET' && method !== 'DELETE') {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body ?? {});
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1${path}`, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw this.transportError(error, timeoutMs);
    }
    if (response.ok || response.status === 304) return response;
    throw await this.statusError(response);
  }

  private transportError(error: unknown, timeoutMs: number): AtvError {
    const name = (error as Error | undefined)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return new AtvError('TIMEOUT', `No response from ${this.baseUrl} within ${timeoutMs}ms`, {
        hint: `Raise --timeout or check the plugin with: agent-atv doctor`,
        details: { timeoutMs },
      });
    }
    const cause = (error as { cause?: { code?: string; message?: string } } | undefined)?.cause;
    const reason = cause?.code ?? cause?.message ?? (error as Error | undefined)?.message ?? 'unknown error';
    return new AtvError('CONNECTION_FAILED', `Cannot reach ${this.baseUrl} (${reason})`, {
      hint: `Run agent-atv doctor; if ${this.baseUrl} stays unreachable, ask the user whether Homebridge is running.`,
      details: { url: this.baseUrl, reason },
    });
  }

  private async statusError(response: Response): Promise<AtvError> {
    const text = await response.text().catch(() => '');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const error = (parsed as { error?: Record<string, unknown> } | undefined)?.error;
    if (error && typeof error.code === 'string') {
      return new AtvError(error.code, typeof error.message === 'string' ? error.message : error.code, {
        hint: typeof error.hint === 'string' ? error.hint : '',
        details: error.details && typeof error.details === 'object' ? (error.details as Record<string, unknown>) : {},
        status: response.status,
      });
    }
    return new AtvError('HTTP_ERROR', `HTTP ${response.status} from ${this.baseUrl} without an agent-atv error body`, {
      hint: `Check that ${this.baseUrl} is the homebridge-agent-atv API. Try: agent-atv doctor`,
      status: response.status,
      exitCode: response.status >= 500 ? EXIT.unreachable : EXIT.failed,
    });
  }
}

export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '').replace(/\/v1$/, '');
}

export function devicePath(device: string, rest: string): string {
  return `/devices/${encodeURIComponent(device)}${rest}`;
}
