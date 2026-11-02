import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from '../logger';
import { errorMessage } from '../logger';
import { isAuthorized } from './auth';
import { ApiError, badRequest } from './errors';

export const MAX_BODY_BYTES = 64 * 1024;

export type Body = Record<string, unknown>;

export interface RouteContext {
  params: Record<string, string>;
  query: URLSearchParams;
  body: Body;
  /** Aborted when the client goes away. */
  signal: AbortSignal;
}

export interface RouteResult {
  status?: number;
  json?: unknown;
  binary?: { data: Buffer; contentType: string };
  headers?: Record<string, string>;
}

export interface Route {
  method: string;
  path: string;
  public?: boolean;
  handler: (context: RouteContext) => Promise<RouteResult> | RouteResult;
}

interface CompiledRoute extends Route {
  pattern: RegExp;
  names: string[];
}

function compile(route: Route): CompiledRoute {
  const names: string[] = [];
  const source = route.path
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(segment.slice(1));
      return '([^/]+)';
    })
    .join('/');
  return { ...route, pattern: new RegExp(`^${source}/?$`), names };
}

class BodyError extends Error {
  constructor(readonly apiError: ApiError) {
    super(apiError.message);
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? '0');
    if (declared > MAX_BODY_BYTES) {
      reject(new BodyError(new ApiError('PAYLOAD_TOO_LARGE', `The request body exceeds ${MAX_BODY_BYTES} bytes`)));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyError(new ApiError('PAYLOAD_TOO_LARGE', `The request body exceeds ${MAX_BODY_BYTES} bytes`)));
        req.removeAllListeners('data');
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseBody(req: IncomingMessage, raw: Buffer): Body {
  if (raw.length === 0 || raw.toString('utf8').trim() === '') return {};
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') {
    throw new ApiError('UNSUPPORTED_MEDIA_TYPE', 'Request bodies must be JSON (Content-Type: application/json)');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new ApiError('BAD_REQUEST', 'The request body is not valid JSON', { field: 'body' });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError('BAD_REQUEST', 'The request body must be a JSON object', { field: 'body' });
  }
  return value as Body;
}

/** The node:http server of DESIGN.md §3.1. */
export class ApiServer {
  private server: Server | null = null;
  private readonly routes: CompiledRoute[];

  constructor(
    private readonly options: { routes: Route[]; token: string; version: string; log: Logger },
  ) {
    this.routes = options.routes.map(compile);
  }

  /** Resolves false (after logging) when the port can't be bound. */
  listen(host: string, port: number): Promise<boolean> {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        this.options.log.error(`HTTP request failed: ${errorMessage(error)}`);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    // Both only bound receiving the request; a long wait or screenshot response is not affected.
    server.headersTimeout = 20_000;
    server.requestTimeout = 60_000;
    server.maxConnections = 128;
    server.on('clientError', (_error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      else socket.destroy();
    });
    return new Promise((resolve) => {
      const onError = (error: NodeJS.ErrnoException) => {
        const fix =
          error.code === 'EADDRINUSE'
            ? `port ${port} is already in use; pick another api.port in the plugin settings`
            : error.code === 'EADDRNOTAVAIL'
              ? `${host} is not an address of this host; fix api.bind (port ${port}) in the plugin settings`
              : `check api.bind and api.port (${host}:${port}) in the plugin settings`;
        this.options.log.error(`The agent-atv HTTP API is off: cannot listen on ${host}:${port} (${error.code ?? error.message}): ${fix}`);
        resolve(false);
      };
      server.once('error', onError);
      server.listen(port, host, () => {
        server.off('error', onError);
        server.on('error', (error) => this.options.log.error(`HTTP API error: ${error.message}`));
        this.server = server;
        resolve(true);
      });
    });
  }

  address(): { host: string; port: number } | null {
    const address = this.server?.address() as AddressInfo | null | undefined;
    return address ? { host: address.address, port: address.port } : null;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = (req.method ?? 'GET').toUpperCase();
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    let result: RouteResult;
    try {
      result = await this.dispatch(req, method, url, abort.signal);
    } catch (error) {
      result = this.errorResult(error, method, url.pathname);
    }
    this.send(res, result);
    this.options.log.debug(`${method} ${url.pathname} ${result.status ?? 200} ${Date.now() - started}ms`);
  }

  private async dispatch(req: IncomingMessage, method: string, url: URL, signal: AbortSignal): Promise<RouteResult> {
    const pathname = url.pathname;
    const matches = this.routes
      .map((route) => ({ route, match: route.pattern.exec(pathname) }))
      .filter((m): m is { route: CompiledRoute; match: RegExpExecArray } => m.match !== null);
    const found = matches.find((m) => m.route.method === method);

    if (!found?.route.public && !isAuthorized(req.headers.authorization, this.options.token)) {
      req.resume();
      throw new ApiError('UNAUTHORIZED', 'Missing or invalid API token', {}, {
        headers: { 'WWW-Authenticate': 'Bearer realm="agent-atv"' },
      });
    }
    if (!found) {
      req.resume();
      throw new ApiError('ROUTE_NOT_FOUND', `No route for ${method} ${pathname}`, { method, path: pathname });
    }
    let raw: Buffer;
    try {
      raw = await readBody(req);
    } catch (error) {
      if (error instanceof BodyError) throw error.apiError;
      throw error;
    }
    const body = parseBody(req, raw);
    const params: Record<string, string> = {};
    found.route.names.forEach((name, index) => {
      try {
        params[name] = decodeURIComponent(found.match[index + 1]!);
      } catch {
        throw badRequest(name, `${name} is not a valid URL path segment`);
      }
    });
    return found.route.handler({ params, query: url.searchParams, body, signal });
  }

  private errorResult(error: unknown, method: string, pathname: string): RouteResult {
    if (error instanceof ApiError) return { status: error.status, json: error.toBody(), headers: error.headers };
    this.options.log.error(`${method} ${pathname} failed: ${errorMessage(error)}`);
    const internal = new ApiError('INTERNAL', 'Internal error in the plugin; see the Homebridge log');
    return { status: 500, json: internal.toBody() };
  }

  private send(res: ServerResponse, result: RouteResult): void {
    if (res.headersSent || res.destroyed) return;
    const headers: Record<string, string | number> = {
      'X-Agent-ATV-Version': this.options.version,
      ...result.headers,
    };
    const status = result.status ?? 200;
    if (result.binary) {
      headers['Content-Type'] = result.binary.contentType;
      headers['Content-Length'] = result.binary.data.length;
      res.writeHead(status, headers);
      res.end(result.binary.data);
      return;
    }
    if (result.json === undefined) {
      res.writeHead(status, headers);
      res.end();
      return;
    }
    const payload = Buffer.from(JSON.stringify(result.json), 'utf8');
    headers['Content-Type'] = 'application/json; charset=utf-8';
    headers['Content-Length'] = payload.length;
    res.writeHead(status, headers);
    res.end(payload);
  }
}
