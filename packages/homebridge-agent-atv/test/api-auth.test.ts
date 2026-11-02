import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeBridge } from './support/fake-bridge';
import { makeStorage, startPlugin, stopAll, TEST_TOKEN } from './support/harness';

afterEach(stopAll);

describe('auth and token (P1)', () => {
  it('serves /health without a token and stamps the plugin version on every response', async () => {
    const plugin = await startPlugin({ spawnBridge: new FakeBridge().spawn });

    const health = await plugin.request('GET', '/health', { token: null });

    expect(health.status).toBe(200);
    expect(health.body).toEqual({ ok: true, name: 'homebridge-agent-atv', version: '0.1.0' });
    expect(health.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(health.headers.get('x-agent-atv-version')).toBe('0.1.0');
    expect(health.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects a missing or wrong bearer token with 401 and a Bearer challenge', async () => {
    const plugin = await startPlugin({ spawnBridge: new FakeBridge().spawn });

    for (const token of [null, 'nope', `${TEST_TOKEN}x`]) {
      const response = await plugin.request('GET', '/devices', { token });
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer realm="agent-atv"');
      expect(response.headers.get('x-agent-atv-version')).toBe('0.1.0');
      expect(response.body.error.code).toBe('UNAUTHORIZED');
      expect(typeof response.body.error.hint).toBe('string');
      expect(response.body.error.hint).not.toBe('');
    }
    expect((await plugin.get('/devices')).status).toBe(200);
  });

  it('generates a token file once (mode 0600), logs where it is without the value, and reuses it on the next start', async () => {
    const storagePath = await makeStorage();
    const first = await startPlugin({ spawnBridge: new FakeBridge().spawn, storagePath, token: null });
    const tokenPath = path.join(storagePath, 'agent-atv', 'token');
    const token = (await readFile(tokenPath, 'utf8')).trim();

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(storagePath, 'agent-atv'))).mode & 0o777).toBe(0o700);
    expect(first.log.at('warn')).toContain(
      `Generated a new agent-atv API token in ${tokenPath} (mode 0600). Copy it from the plugin settings UI.`,
    );
    expect(first.log.text).not.toContain(token);
    first.token = token;
    expect((await first.get('/devices')).status).toBe(200);
    await first.stop();

    const second = await startPlugin({ spawnBridge: new FakeBridge().spawn, storagePath, token: null });
    second.token = token;
    expect((await second.get('/devices')).status).toBe(200);
    expect(second.log.text).not.toContain(token);
    expect(second.log.at('info')).toContain(`API token loaded from ${tokenPath} (…${token.slice(-4)})`);
  });

  it('refuses to start the API with a configured token shorter than 32 characters', async () => {
    const plugin = await startPlugin({ spawnBridge: new FakeBridge().spawn, token: 'short' });

    expect(plugin.core.address()).toBeNull();
    expect(plugin.log.at('error').join('\n')).toMatch(/at least 32 characters/);
  });

  it('logs an actionable error and keeps running when the port is taken', async () => {
    const first = await startPlugin({ spawnBridge: new FakeBridge().spawn });
    const port = first.core.address()?.port;

    const second = await startPlugin({ spawnBridge: new FakeBridge().spawn, config: { api: { port } } });

    expect(second.core.address()).toBeNull();
    expect(second.log.at('error').join('\n')).toMatch(new RegExp(`${port}.*api\\.port`, 's'));
  });
});
