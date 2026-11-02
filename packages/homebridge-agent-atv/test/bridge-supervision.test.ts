import { ACCESS_DENIED_HINT } from '../src/api/errors';
import { afterEach, describe, expect, it } from 'vitest';
import { DEVICE_ID, installAppleTv } from './support/apple-tv';
import { BridgeFailure, FakeBridge, NO_RESPONSE, delay } from './support/fake-bridge';
import { eventually, makeStorage, seedPairedDevice, startPlugin, stopAll, waitConnected } from './support/harness';

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

describe('bridge supervision (P1)', () => {
  it('restarts a crashed bridge with growing backoff and reconnects paired devices after ready', async () => {
    const { plugin, bridge } = await connectedPlugin();

    const firstCrash = Date.now();
    bridge.crash();
    await eventually(() => bridge.spawns.length === 2, 3000);
    expect(Date.now() - firstCrash).toBeGreaterThanOrEqual(950);
    await waitConnected(plugin);
    expect(bridge.calls('connect')).toHaveLength(2);
    expect(plugin.log.at('error').join('\n')).toMatch(/bridge exited unexpectedly/);

    const secondCrash = Date.now();
    bridge.crash();
    await eventually(() => bridge.spawns.length === 3, 4000);
    expect(Date.now() - secondCrash).toBeGreaterThanOrEqual(1950);
    await waitConnected(plugin);
  }, 15_000);

  it('fails in-flight requests with BRIDGE_UNAVAILABLE when the bridge dies', async () => {
    const { plugin, bridge } = await connectedPlugin();
    bridge.handle('apps.list', () => NO_RESPONSE);

    const pending = plugin.get(`/devices/${DEVICE_ID}/apps`);
    await eventually(() => bridge.calls('apps.list').length === 1);
    bridge.crash();
    const response = await pending;

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('BRIDGE_UNAVAILABLE');
    expect(response.body.error.hint).toBe('Wait a few seconds and retry; if it persists, run agent-atv doctor.');
  });

  it('fails a request with BRIDGE_TIMEOUT after its method timeout and drops the late response', async () => {
    const { plugin, bridge } = await connectedPlugin();
    let answer: (() => void) | undefined;
    bridge.handle('key', () => new Promise((resolve) => (answer = () => resolve({}))));

    const started = Date.now();
    const response = await plugin.post(`/devices/${DEVICE_ID}/keys`, { keys: [{ key: 'select' }] });

    expect(response.status).toBe(504);
    expect(response.body.error.code).toBe('BRIDGE_TIMEOUT');
    expect(Date.now() - started).toBeGreaterThanOrEqual(9900);
    answer?.();
    await delay(50);
    expect(plugin.log.at('error')).toEqual([]);
    expect((await plugin.get(`/devices/${DEVICE_ID}/state`)).status).toBe(200);
  }, 20_000);

  it('forwards bridge stderr by level and survives garbage on stdout', async () => {
    const { plugin, bridge } = await connectedPlugin();

    bridge.logStderr('ERROR agent_atv_bridge.server: boom');
    bridge.logStderr('WARNING pyatv: slow');
    bridge.logStderr('INFO agent_atv_bridge: hello');
    bridge.writeRaw('this is not json\n');
    bridge.writeRaw(`${'x'.repeat(4 * 1024 * 1024 + 10)}\n`);

    await eventually(() => plugin.log.at('debug').some((m) => m.includes('agent_atv_bridge: hello')));
    expect(plugin.log.at('error')).toContainEqual(expect.stringContaining('agent_atv_bridge.server: boom'));
    expect(plugin.log.at('warn')).toContainEqual(expect.stringContaining('pyatv: slow'));
    await eventually(() => plugin.log.at('error').some((m) => /longer than/.test(m)));
    expect((await plugin.get(`/devices/${DEVICE_ID}/state`)).status).toBe(200);
  });

  it('passes bridge error codes through with their HTTP status and maps UNKNOWN_METHOD to INTERNAL', async () => {
    const { plugin, bridge } = await connectedPlugin();
    const cases: [string, number, string, string][] = [
      ['NOT_SUPPORTED', 501, 'NOT_SUPPORTED', 'This Apple TV does not support that; try another way, starting from agent-atv snapshot.'],
      ['DEVICE_ERROR', 502, 'DEVICE_ERROR', 'Retry; if it persists, run agent-atv doctor.'],
      ['DEVICE_OFF', 409, 'DEVICE_OFF', 'Turn the Apple TV on with: agent-atv power on'],
      ['ACCESS_DENIED', 503, 'ACCESS_DENIED', ACCESS_DENIED_HINT],
      ['UNKNOWN_METHOD', 500, 'INTERNAL', 'Retry; if it persists, ask the user to check the Homebridge log and update the plugin.'],
    ];
    for (const [code, status, expected, hint] of cases) {
      bridge.handle('seek', () => {
        throw new BridgeFailure(code, 'nope', { feature: 'seek' });
      });
      const response = await plugin.post(`/devices/${DEVICE_ID}/seek`, { position: 1 });
      expect([response.status, response.body.error.code], code).toEqual([status, expected]);
      expect(response.body.error.hint, code).toBe(hint);
    }
  });

  it('reconnects after a connection event, about 2 s later', async () => {
    const { plugin, bridge, tv } = await connectedPlugin();

    const dropped = Date.now();
    tv.dropConnection();
    await eventually(async () => (await plugin.get(`/devices/${DEVICE_ID}/state`)).body.connection === 'connecting');
    await waitConnected(plugin);

    expect(Date.now() - dropped).toBeGreaterThanOrEqual(1900);
    expect(bridge.calls('connect')).toHaveLength(2);
  }, 10_000);

  it('warns with the Home app hint and keeps retrying when the Apple TV denies access', async () => {
    const storagePath = await makeStorage();
    await seedPairedDevice(storagePath);
    const bridge = new FakeBridge();
    installAppleTv(bridge);
    bridge.handle('connect', () => {
      throw new BridgeFailure('ACCESS_DENIED', 'Failed to set up remote control channel');
    });
    const plugin = await startPlugin({ spawnBridge: bridge.spawn, storagePath });

    await eventually(() => bridge.calls('connect').length === 1);
    await delay(50);

    expect(plugin.log.at('warn').filter((m) => m.includes('Speakers & TVs'))).toHaveLength(1);
    expect((await plugin.get(`/devices/${DEVICE_ID}/state`)).body.connection).toBe('connecting');
  });

  it('warns once when a paired device cannot be reached, and keeps retrying', async () => {
    const storagePath = await makeStorage();
    await seedPairedDevice(storagePath);
    const bridge = new FakeBridge();
    installAppleTv(bridge);
    bridge.handle('connect', () => {
      throw new BridgeFailure('DEVICE_NOT_FOUND', 'Device A1B2C3D4E5F6 was not found', { device: DEVICE_ID });
    });
    const plugin = await startPlugin({ spawnBridge: bridge.spawn, storagePath });

    await eventually(() => bridge.calls('connect').length === 1);
    await delay(50);

    expect(plugin.log.at('warn')).toEqual([
      'Living Room: cannot connect (DEVICE_NOT_FOUND: Device A1B2C3D4E5F6 was not found); retrying in the background',
    ]);
    expect((await plugin.get(`/devices/${DEVICE_ID}/state`)).body.connection).toBe('connecting');
  });

  it('sends shutdown on stop and does not restart the bridge', async () => {
    const { plugin, bridge } = await connectedPlugin();

    await plugin.stop();
    await delay(1200);

    expect(bridge.calls('shutdown')).toEqual([{}]);
    expect(bridge.spawns).toHaveLength(1);
    expect(bridge.running).toBe(false);
  });
});
