import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export interface CannedResponse {
  status?: number;
  body?: unknown;
  raw?: Buffer | string;
  headers?: Record<string, string>;
  delayMs?: number;
}

type Responder = CannedResponse | ((request: RecordedRequest) => CannedResponse);

export interface FakeApi {
  url: string;
  requests: RecordedRequest[];
  /** Replaces the route. Several responses are served in order and the last one repeats. */
  on(method: string, path: string, ...responses: Responder[]): void;
  close(): Promise<void>;
}

export async function startFakeApi(): Promise<FakeApi> {
  const routes = new Map<string, Responder[]>();
  const requests: RecordedRequest[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const recorded: RecordedRequest = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: text === '' ? undefined : JSON.parse(text),
      };
      requests.push(recorded);
      const queue = routes.get(`${recorded.method} ${recorded.path}`);
      const responder = queue && queue.length > 1 ? queue.shift() : queue?.[0];
      const canned: CannedResponse = responder
        ? typeof responder === 'function'
          ? responder(recorded)
          : responder
        : {
            status: 404,
            body: { error: { code: 'ROUTE_NOT_FOUND', message: `No route ${recorded.method} ${recorded.path}`, hint: '', details: {} } },
          };
      const send = (): void => {
        if (canned.raw !== undefined) {
          res.writeHead(canned.status ?? 200, canned.headers ?? {});
          res.end(canned.raw);
          return;
        }
        res.writeHead(canned.status ?? 200, {
          'content-type': 'application/json; charset=utf-8',
          ...canned.headers,
        });
        res.end(canned.body === undefined ? '' : JSON.stringify(canned.body));
      };
      if (canned.delayMs) setTimeout(send, canned.delayMs);
      else send();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    on(method, path, ...responses) {
      routes.set(`${method} ${path}`, [...responses]);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
