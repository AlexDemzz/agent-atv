/* global fetch, AbortSignal */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';

const PLATFORM = 'AgentATV';
const REQUEST_TIMEOUT_MS = 40_000;
// One PIN can chain pair.pin, pair.verify, pair.begin and a reconnect on the plugin, 30 s each at worst.
const PAIRING_TIMEOUT_MS = 120_000;

/** Proxies the settings UI to the plugin's own HTTP API (DESIGN.md §5.6). */
class AgentAtvUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest('/info', () => this.api('GET', '/info'));
    this.onRequest('/devices', () => this.api('GET', '/devices'));
    this.onRequest('/scan', (payload) => this.api('POST', '/scan', { timeoutMs: payload?.timeoutMs ?? 5000 }));
    this.onRequest('/pair', (payload) =>
      this.api('POST', `/devices/${this.segment(payload?.device, 'device')}/pair`, payload?.protocol ? { protocol: payload.protocol } : {}, PAIRING_TIMEOUT_MS),
    );
    this.onRequest('/pin', (payload) =>
      this.api('POST', `/pairings/${this.segment(payload?.pairingId, 'pairingId')}/pin`, { pin: String(payload?.pin ?? '') }, PAIRING_TIMEOUT_MS),
    );
    this.onRequest('/cancel', (payload) => this.api('DELETE', `/pairings/${this.segment(payload?.pairingId, 'pairingId')}`));
    this.onRequest('/unpair', (payload) => this.api('DELETE', `/devices/${this.segment(payload?.device, 'device')}/pairing`));
    this.onRequest('/screen', () => this.api('POST', '/screen', { enabled: true }));
    this.onRequest('/token', async () => {
      const settings = await this.settings();
      return { token: settings.token, port: settings.port, bind: settings.bind };
    });
    this.ready();
  }

  segment(value, name) {
    if (typeof value !== 'string' || value === '') throw new RequestError(`${name} is required`, { code: 'BAD_REQUEST' });
    return encodeURIComponent(value);
  }

  async settings() {
    let platform;
    try {
      const config = JSON.parse(await readFile(this.homebridgeConfigPath, 'utf8'));
      platform = (config.platforms ?? []).find((p) => p?.platform === PLATFORM) ?? {};
    } catch (error) {
      throw new RequestError(`Cannot read the Homebridge config: ${error.message}`, { code: 'CONFIG' });
    }
    const api = platform.api ?? {};
    const port = Number.isInteger(api.port) ? api.port : 8787;
    const bind = typeof api.bind === 'string' && api.bind.trim() !== '' ? api.bind.trim() : '0.0.0.0';
    const host = bind === '0.0.0.0' || bind === '::' ? '127.0.0.1' : bind;
    let token = typeof api.token === 'string' ? api.token.trim() : '';
    if (token === '') {
      const tokenPath = path.join(this.homebridgeStoragePath, 'agent-atv', 'token');
      try {
        token = (await readFile(tokenPath, 'utf8')).trim();
      } catch {
        throw new RequestError('The API token does not exist yet. Save the plugin settings and restart Homebridge, then reopen this page.', {
          code: 'NO_TOKEN',
        });
      }
    }
    return { token, port, bind, host };
  }

  async api(method, pathname, body, timeoutMs = REQUEST_TIMEOUT_MS) {
    const { token, port, host } = await this.settings();
    const base = `http://${host.includes(':') ? `[${host}]` : host}:${port}/v1`;
    let response;
    try {
      response = await fetch(`${base}${pathname}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error.name === 'TimeoutError') {
        throw new RequestError(`The agent-atv API did not answer within ${timeoutMs / 1000} s. The Apple TV may be slow to respond; refresh the device list and try again.`, {
          code: 'TIMEOUT',
        });
      }
      throw new RequestError(
        `The agent-atv API is not reachable at ${base} (${error.cause?.code ?? error.message}). Check that the plugin is running and its HTTP API settings, then restart Homebridge.`,
        { code: 'CONNECTION_FAILED' },
      );
    }
    const text = await response.text();
    let json;
    try {
      json = text === '' ? {} : JSON.parse(text);
    } catch {
      json = null;
    }
    if (!response.ok) {
      const error = json?.error;
      throw new RequestError(error?.message ?? `The agent-atv API answered ${response.status}`, {
        status: response.status,
        code: error?.code ?? 'HTTP_ERROR',
        hint: error?.hint ?? '',
        details: error?.details ?? {},
      });
    }
    return json;
  }
}

(() => new AgentAtvUiServer())();
