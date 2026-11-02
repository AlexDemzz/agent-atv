import { afterEach, describe, expect, it } from 'vitest';
import { DEVICE_ID, installAppleTv } from './support/apple-tv';
import { BridgeFailure, FakeBridge } from './support/fake-bridge';
import { makeStorage, seedPairedDevice, startPlugin, stopAll, waitConnected } from './support/harness';

afterEach(stopAll);

async function connectedPlugin() {
  const storagePath = await makeStorage();
  await seedPairedDevice(storagePath);
  const bridge = new FakeBridge();
  const tv = installAppleTv(bridge);
  const plugin = await startPlugin({ spawnBridge: bridge.spawn, storagePath });
  await waitConnected(plugin);
  return { plugin, bridge, tv };
}

describe('POST /devices/:device/keys (P1)', () => {
  it('presses each key in order, expanding counts, intervalMs apart', async () => {
    const { plugin, bridge } = await connectedPlugin();

    const response = await plugin.post(`/devices/${DEVICE_ID}/keys`, {
      keys: [{ key: 'down', count: 2 }, { key: 'right' }, { key: 'select', action: 'hold' }],
      intervalMs: 60,
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, pressed: 4, state: { device: { id: DEVICE_ID } } });
    const keyRequests = bridge.requests.filter((r) => r.method === 'key');
    expect(keyRequests.map((r) => r.params)).toEqual([
      { device: DEVICE_ID, key: 'down', action: 'tap' },
      { device: DEVICE_ID, key: 'down', action: 'tap' },
      { device: DEVICE_ID, key: 'right', action: 'tap' },
      { device: DEVICE_ID, key: 'select', action: 'hold' },
    ]);
    for (let i = 1; i < keyRequests.length; i++) {
      expect(keyRequests[i]!.at - keyRequests[i - 1]!.at).toBeGreaterThanOrEqual(55);
    }
  });

  it.each([
    [{ keys: [] }, 'keys'],
    [{ keys: [{ key: 'jump' }] }, 'keys[0].key'],
    [{ keys: [{ key: 'up' }, { key: 'play', action: 'double' }] }, 'keys[1].action'],
    [{ keys: [{ key: 'up', action: 'press' }] }, 'keys[0].action'],
    [{ keys: [{ key: 'up', count: 51 }] }, 'keys[0].count'],
    [{ keys: [{ key: 'up', count: 0 }] }, 'keys[0].count'],
    [{ keys: [{ key: 'up', count: 50 }, { key: 'down', count: 50 }, { key: 'left' }] }, 'keys'],
    [{ keys: [{ key: 'up' }], intervalMs: 5001 }, 'intervalMs'],
  ])('rejects %j before pressing anything (field %s)', async (body, field) => {
    const { plugin, bridge } = await connectedPlugin();

    const response = await plugin.post(`/devices/${DEVICE_ID}/keys`, body);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('BAD_REQUEST');
    expect(response.body.error.details.field).toBe(field);
    expect(bridge.calls('key')).toEqual([]);
  });

  it('stops at the first failing press and reports how many went through', async () => {
    const { plugin, bridge } = await connectedPlugin();
    let presses = 0;
    bridge.handle('key', () => {
      presses += 1;
      if (presses === 3) throw new BridgeFailure('DEVICE_TIMEOUT', 'timed out');
      return {};
    });

    const response = await plugin.post(`/devices/${DEVICE_ID}/keys`, {
      keys: [{ key: 'up', count: 5 }],
      intervalMs: 0,
    });

    expect(response.status).toBe(504);
    expect(response.body.error).toMatchObject({ code: 'DEVICE_TIMEOUT', details: { pressed: 2 } });
    expect(response.body.error.hint).not.toBe('');
    expect(presses).toBe(3);
  });

  it('refuses an unpaired device with NOT_PAIRED and a dropped connection with NOT_CONNECTED', async () => {
    const { plugin, tv } = await connectedPlugin();

    tv.dropConnection();
    const down = await plugin.post(`/devices/${DEVICE_ID}/keys`, { keys: [{ key: 'up' }] });
    expect(down.status).toBe(503);
    expect(down.body.error).toMatchObject({ code: 'NOT_CONNECTED', details: { connection: 'connecting' } });

    expect((await plugin.request('DELETE', `/devices/${DEVICE_ID}/pairing`)).status).toBe(200);
    const unpaired = await plugin.post(`/devices/${DEVICE_ID}/keys`, { keys: [{ key: 'up' }] });
    expect(unpaired.status).toBe(409);
    expect(unpaired.body.error.code).toBe('NOT_PAIRED');
    expect(unpaired.body.error.hint).toContain('agent-atv pair');
  });
});

describe('request handling (P1)', () => {
  it('rejects non-JSON bodies, invalid JSON, oversized bodies and unknown routes', async () => {
    const { plugin } = await connectedPlugin();
    const path = `/devices/${DEVICE_ID}/keys`;

    const text = await plugin.request('POST', path, { rawBody: 'keys=up', headers: { 'content-type': 'text/plain' } });
    expect([text.status, text.body.error.code]).toEqual([415, 'UNSUPPORTED_MEDIA_TYPE']);

    const broken = await plugin.request('POST', path, { rawBody: '{"keys": [', headers: { 'content-type': 'application/json' } });
    expect([broken.status, broken.body.error.code]).toEqual([400, 'BAD_REQUEST']);

    const huge = await plugin.request('POST', path, {
      rawBody: JSON.stringify({ keys: [{ key: 'up' }], pad: 'x'.repeat(70 * 1024) }),
      headers: { 'content-type': 'application/json' },
    });
    expect([huge.status, huge.body.error.code]).toEqual([413, 'PAYLOAD_TOO_LARGE']);

    const unknown = await plugin.get('/nothing-here');
    expect([unknown.status, unknown.body.error.code]).toEqual([404, 'ROUTE_NOT_FOUND']);
    const wrongMethod = await plugin.request('PUT', path, { body: {} });
    expect([wrongMethod.status, wrongMethod.body.error.code]).toEqual([404, 'ROUTE_NOT_FOUND']);
  });

  it('treats an empty POST body as {}', async () => {
    const { plugin } = await connectedPlugin();

    const response = await plugin.request('POST', '/scan', { rawBody: '' });

    expect(response.status).toBe(200);
  });

  it('logs each request at debug without the token', async () => {
    const { plugin } = await connectedPlugin();

    await plugin.get(`/devices/${DEVICE_ID}/state`);

    expect(plugin.log.at('debug')).toContainEqual(expect.stringMatching(new RegExp(`^GET /v1/devices/${DEVICE_ID}/state 200 \\d+ms$`)));
    expect(plugin.log.text).not.toContain(plugin.token);
  });
});
