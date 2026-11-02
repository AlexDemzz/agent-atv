import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AIRPLAY_CREDS, COMPANION_CREDS, DEVICE_ID, installAppleTv, scanDevice } from './support/apple-tv';
import { FakeBridge } from './support/fake-bridge';
import { eventually, makeStorage, seedPairedDevice, startPlugin, stopAll, waitConnected } from './support/harness';

afterEach(stopAll);

const pkgDir = path.resolve(__dirname, '..');

describe('bridge process and /info (P1)', () => {
  it('spawns the bridge in fake mode with python.executable, the python dir as cwd and PYTHONPATH', async () => {
    const bridge = new FakeBridge();
    await startPlugin({ spawnBridge: bridge.spawn, config: { python: { executable: '/usr/bin/python3.11' } } });

    expect(bridge.spawns).toHaveLength(1);
    const spawn = bridge.spawns[0]!;
    expect(spawn.command).toBe('/usr/bin/python3.11');
    expect(spawn.args).toEqual(['-u', '-m', 'agent_atv_bridge', '--fake']);
    expect(spawn.cwd).toBe(path.join(pkgDir, 'python'));
    expect(spawn.env.PYTHONPATH).toBe(path.join(pkgDir, 'python'));
  });

  it('reports the bridge from its ready event, and the device count', async () => {
    const storagePath = await makeStorage();
    await seedPairedDevice(storagePath);
    const bridge = new FakeBridge();
    installAppleTv(bridge);
    const plugin = await startPlugin({ spawnBridge: bridge.spawn, storagePath });

    const info = await plugin.get('/info');

    expect(info.status).toBe(200);
    expect(info.body).toEqual({
      version: '0.1.0',
      bridge: { status: 'ready', backend: 'fake', python: '3.11.2', pyatv: null, error: null },
      screen: { enabled: false, status: 'disabled', ready: false, reason: 'screen.enabled is off', pymobiledevice3: null },
      devices: 1,
    });
  });

  it('serves the API before the bridge is ready, then connects paired devices once it is', async () => {
    const storagePath = await makeStorage();
    await seedPairedDevice(storagePath);
    const bridge = new FakeBridge();
    installAppleTv(bridge);
    bridge.sendsReady = false;
    const plugin = await startPlugin({ spawnBridge: bridge.spawn, storagePath, awaitStart: false });

    expect((await plugin.get('/info')).body.bridge.status).toBe('starting');
    const early = await plugin.post(`/devices/${DEVICE_ID}/keys`, { keys: [{ key: 'up' }] });
    expect([early.status, early.body.error.code, early.body.error.details.status]).toEqual([
      503,
      'BRIDGE_UNAVAILABLE',
      'starting',
    ]);

    bridge.event('ready', undefined, bridge.readyEvent);
    await waitConnected(plugin);
    expect((await plugin.get('/info')).body.bridge.status).toBe('ready');
  });

  it('answers device routes with BRIDGE_UNAVAILABLE while the bridge is down', async () => {
    const storagePath = await makeStorage();
    await seedPairedDevice(storagePath);
    const bridge = new FakeBridge();
    installAppleTv(bridge);
    const plugin = await startPlugin({ spawnBridge: bridge.spawn, storagePath });
    await waitConnected(plugin);

    bridge.crash();
    await eventually(async () => (await plugin.get('/info')).body.bridge.status === 'restarting');
    const response = await plugin.post(`/devices/${DEVICE_ID}/keys`, { keys: [{ key: 'up' }] });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('BRIDGE_UNAVAILABLE');
    expect(response.body.error.details.status).toBe('restarting');
    expect(response.body.error.hint).toBe('Wait a few seconds and retry; if it persists, run agent-atv doctor.');
  });
});

describe('devices and addressing (P1)', () => {
  it('connects every paired device on start with its stored credentials and address', async () => {
    const storagePath = await makeStorage();
    await seedPairedDevice(storagePath);
    const bridge = new FakeBridge();
    installAppleTv(bridge);
    const plugin = await startPlugin({ spawnBridge: bridge.spawn, storagePath });

    await waitConnected(plugin);

    expect(bridge.calls('connect')).toEqual([
      {
        device: DEVICE_ID,
        address: '192.168.1.50',
        credentials: { companion: COMPANION_CREDS, airplay: AIRPLAY_CREDS },
      },
    ]);
    const list = await plugin.get('/devices');
    expect(list.body).toEqual({
      devices: [
        {
          id: DEVICE_ID,
          name: 'Living Room',
          address: '192.168.1.50',
          model: 'Apple TV 4K (gen 3)',
          version: '27.2',
          paired: true,
          needsPairing: false,
          connection: 'connected',
          protocols: { companion: true, airplay: true },
          screen: 'off',
        },
      ],
    });
    expect(JSON.stringify(list.body)).not.toContain(COMPANION_CREDS);
  });

  it('returns the bridge State plus seq, changedAt, connection and needsPairing', async () => {
    const storagePath = await makeStorage();
    await seedPairedDevice(storagePath);
    const bridge = new FakeBridge();
    installAppleTv(bridge);
    const plugin = await startPlugin({ spawnBridge: bridge.spawn, storagePath });
    await waitConnected(plugin);

    const { body } = await plugin.get(`/devices/${DEVICE_ID}/state`);

    expect(body).toMatchObject({
      device: { id: DEVICE_ID, name: 'Living Room', os: 'tvOS', version: '27.2' },
      power: 'on',
      nowPlaying: { bundleId: 'com.apple.TVWatchList', name: 'TV' },
      playing: { state: 'idle', mediaType: 'unknown', title: null },
      keyboard: { focus: 'unfocused', text: null },
      volume: 50,
      protocols: { companion: true, airplay: true },
      connection: 'connected',
      needsPairing: false,
    });
    expect(body.changedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(Number.isInteger(body.seq)).toBe(true);
    expect(JSON.stringify(body)).not.toContain(COMPANION_CREDS);
  });

  it('increments seq when the State changes, but not for playback position alone', async () => {
    const storagePath = await makeStorage();
    await seedPairedDevice(storagePath);
    const bridge = new FakeBridge();
    const tv = installAppleTv(bridge);
    const plugin = await startPlugin({ spawnBridge: bridge.spawn, storagePath });
    await waitConnected(plugin);
    const stateOf = async () => (await plugin.get(`/devices/${DEVICE_ID}/state`)).body;
    const before = await stateOf();

    tv.state.playing = { ...tv.state.playing, state: 'playing', title: 'Chapter One', position: 10, totalTime: 3490 };
    tv.push();
    const playing = await eventually(async () => {
      const s = await stateOf();
      return s.playing.state === 'playing' ? s : null;
    });
    expect(playing.seq).toBe(before.seq + 1);
    expect(Date.parse(playing.changedAt)).toBeGreaterThanOrEqual(Date.parse(before.changedAt));

    tv.state.playing.position = 11;
    tv.push();
    const moved = await eventually(async () => {
      const s = await stateOf();
      return s.playing.position === 11 ? s : null;
    });
    expect(moved.seq).toBe(playing.seq);
    expect(moved.changedAt).toBe(playing.changedAt);
  });

  it('refreshes the State from the bridge with ?refresh=1', async () => {
    const storagePath = await makeStorage();
    await seedPairedDevice(storagePath);
    const bridge = new FakeBridge();
    const tv = installAppleTv(bridge);
    const plugin = await startPlugin({ spawnBridge: bridge.spawn, storagePath });
    await waitConnected(plugin);
    tv.state.volume = 35;

    expect((await plugin.get(`/devices/${DEVICE_ID}/state`)).body.volume).toBe(50);
    expect((await plugin.get(`/devices/${DEVICE_ID}/state?refresh=1`)).body.volume).toBe(35);
    expect(bridge.calls('state')).toEqual([{ device: DEVICE_ID, refresh: true }]);
  });

  it('addresses a device by id (any case), name (any case) or default', async () => {
    const storagePath = await makeStorage();
    await seedPairedDevice(storagePath);
    const bridge = new FakeBridge();
    installAppleTv(bridge);
    const plugin = await startPlugin({ spawnBridge: bridge.spawn, storagePath });
    await waitConnected(plugin);

    for (const ref of ['a1b2c3d4e5f6', 'living%20room', 'LIVING%20ROOM', 'default']) {
      const response = await plugin.get(`/devices/${ref}/state`);
      expect(response.status, ref).toBe(200);
      expect(response.body.device.id).toBe(DEVICE_ID);
    }
    const missing = await plugin.get('/devices/Kitchen/state');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('DEVICE_NOT_FOUND');
  });

  it('answers 400 BAD_REQUEST for a malformed percent-escape in the path', async () => {
    const plugin = await startPlugin({ spawnBridge: new FakeBridge().spawn });

    const response = await plugin.get('/devices/%E0%A4%A/state');

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: 'BAD_REQUEST', details: { field: 'device' } });
    expect(plugin.log.at('error')).toEqual([]);
  });

  it('matches a configured display name', async () => {
    const storagePath = await makeStorage();
    await seedPairedDevice(storagePath);
    const bridge = new FakeBridge();
    installAppleTv(bridge);
    const plugin = await startPlugin({
      spawnBridge: bridge.spawn,
      storagePath,
      config: { devices: [{ id: DEVICE_ID, name: 'Den' }] },
    });

    expect((await plugin.get('/devices/den/state')).body.device.id).toBe(DEVICE_ID);
    expect((await plugin.get('/devices')).body.devices[0].name).toBe('Den');
  });

  it('merges a device configured by another pyatv identifier into the scanned device', async () => {
    const bridge = new FakeBridge();
    bridge.handle('scan', () => ({ devices: [scanDevice()] }));
    const plugin = await startPlugin({
      spawnBridge: bridge.spawn,
      config: {
        discovery: { enabled: true },
        devices: [{ id: '0E5C1C1E-3A4B-4C7D-9E2F-6A1B2C3D4E5F', name: 'Den', address: '10.0.0.9' }],
      },
    });

    const devices = await eventually(async () => {
      const list = (await plugin.get('/devices')).body.devices;
      return list.some((d: { id: string }) => d.id === DEVICE_ID) ? list : null;
    });

    expect(devices).toEqual([expect.objectContaining({ id: DEVICE_ID, name: 'Den', address: '10.0.0.9' })]);
    expect((await plugin.get('/devices/0e5c1c1e-3a4b-4c7d-9e2f-6a1b2c3d4e5f/state')).body.device.id).toBe(DEVICE_ID);
  });

  it('answers default with NOT_PAIRED when nothing is paired and AMBIGUOUS_DEVICE when several are', async () => {
    const empty = await startPlugin({ spawnBridge: new FakeBridge().spawn });
    const none = await empty.get('/devices/default/state');
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe('NOT_PAIRED');

    const storagePath = await makeStorage();
    await seedPairedDevice(storagePath);
    await seedPairedDevice(storagePath, { id: 'B1B2C3D4E5F6', name: 'Bedroom', address: '192.168.1.51' });
    const bridge = new FakeBridge();
    installAppleTv(bridge);
    const two = await startPlugin({ spawnBridge: bridge.spawn, storagePath });
    const ambiguous = await two.get('/devices/default/state');
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body.error.code).toBe('AMBIGUOUS_DEVICE');
    expect(ambiguous.body.error.details.devices).toEqual(
      expect.arrayContaining([
        { id: DEVICE_ID, name: 'Living Room' },
        { id: 'B1B2C3D4E5F6', name: 'Bedroom' },
      ]),
    );
  });

  it('adds discovered devices as unpaired with a skeleton State', async () => {
    const bridge = new FakeBridge();
    bridge.handle('scan', () => ({ devices: [scanDevice()] }));
    const plugin = await startPlugin({ spawnBridge: bridge.spawn, config: { discovery: { enabled: true } } });

    const state = await eventually(async () => {
      const response = await plugin.get(`/devices/${DEVICE_ID}/state`);
      return response.status === 200 ? response.body : null;
    });

    expect(state).toMatchObject({
      device: { id: DEVICE_ID, name: 'Living Room', model: 'Apple TV 4K (gen 3)', address: '192.168.1.50' },
      power: 'unknown',
      nowPlaying: null,
      playing: { state: 'idle', mediaType: 'unknown', title: null, position: null },
      keyboard: { focus: 'unknown', text: null },
      volume: null,
      protocols: { companion: false, airplay: false },
      connection: 'unpaired',
      needsPairing: false,
    });
    expect(bridge.calls('connect')).toEqual([]);
  });

  it('scans on demand with discovery.hosts and marks paired devices', async () => {
    const storagePath = await makeStorage();
    await seedPairedDevice(storagePath);
    const bridge = new FakeBridge();
    installAppleTv(bridge);
    bridge.handle('scan', () => ({
      devices: [scanDevice(), scanDevice({ id: 'B1B2C3D4E5F6', name: 'Bedroom', identifiers: ['B1B2C3D4E5F6'] })],
    }));
    const plugin = await startPlugin({
      spawnBridge: bridge.spawn,
      storagePath,
      config: { discovery: { enabled: false, hosts: ['192.168.1.50'] } },
    });

    const response = await plugin.post('/scan', { timeoutMs: 3000 });

    expect(response.status).toBe(200);
    expect(bridge.calls('scan')).toEqual([{ timeoutMs: 3000, hosts: ['192.168.1.50'] }]);
    expect(response.body.devices.map((d: { id: string; paired: boolean }) => [d.id, d.paired])).toEqual([
      [DEVICE_ID, true],
      ['B1B2C3D4E5F6', false],
    ]);
    expect(response.body.devices[1]).toMatchObject({ name: 'Bedroom', services: expect.any(Array) });
  });
});
