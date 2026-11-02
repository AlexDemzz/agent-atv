import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { eventually, startPlugin, stopAll, type Plugin } from './support/harness';

const hasPython = spawnSync('python3', ['--version']).status === 0;
const FAKE_ID = 'FAKE00000001';
const base = `/devices/${FAKE_ID}`;

afterEach(stopAll);

async function realBridgePlugin(): Promise<Plugin> {
  const plugin = await startPlugin({
    env: { ...process.env, AGENT_ATV_FAKE_BRIDGE: '1' },
    config: { discovery: { enabled: true }, python: { executable: 'python3' } },
  });
  await eventually(async () => (await plugin.get('/info')).body.bridge.status === 'ready', 10_000);
  return plugin;
}

async function pairFake(plugin: Plugin): Promise<void> {
  await eventually(async () => (await plugin.get('/devices')).body.devices.length > 0, 10_000);
  const begin = await plugin.post(`${base}/pair`);
  expect(begin.status).toBe(200);
  const step2 = await plugin.post(`/pairings/${begin.body.pairingId}/pin`, { pin: '1234' });
  expect(step2.body).toMatchObject({ status: 'next', protocol: 'airplay', step: 2, steps: 2 });
  const done = await plugin.post(`/pairings/${begin.body.pairingId}/pin`, { pin: '1234' });
  expect(done.body).toMatchObject({ status: 'done', device: { id: FAKE_ID, paired: true, connection: 'connected' } });
}

describe.skipIf(!hasPython)('plugin and real bridge contract (P2)', () => {
  it('reports the fake backend from the ready event', async () => {
    const plugin = await realBridgePlugin();

    const { bridge } = (await plugin.get('/info')).body;

    expect(bridge).toMatchObject({ status: 'ready', backend: 'fake', pyatv: null, error: null });
    expect(bridge.python).toMatch(/^3\.\d+/);
  });

  it('scans the fake Apple TV with the ScanDevice shape', async () => {
    const plugin = await realBridgePlugin();

    const { body } = await plugin.post('/scan', { timeoutMs: 500 });

    expect(body.devices).toEqual([
      expect.objectContaining({
        id: FAKE_ID,
        name: 'Fake Apple TV',
        address: '127.0.0.1',
        mac: 'FA:KE:00:00:00:01',
        model: 'Apple TV 4K (gen 3)',
        os: 'tvOS',
        version: '27.2',
        identifiers: expect.arrayContaining([FAKE_ID]),
        services: expect.arrayContaining([
          expect.objectContaining({ protocol: 'companion', pairing: 'mandatory' }),
          expect.objectContaining({ protocol: 'airplay', pairing: 'mandatory' }),
        ]),
        paired: false,
      }),
    ]);
  });

  it('pairs in two steps (pair.verify rejects the Companion credentials), then exposes the initial State', async () => {
    const plugin = await realBridgePlugin();
    await pairFake(plugin);

    const state = (await plugin.get(`${base}/state?refresh=1`)).body;

    expect(state).toMatchObject({
      device: { id: FAKE_ID, name: 'Fake Apple TV', os: 'tvOS', version: '27.2' },
      power: 'on',
      nowPlaying: { bundleId: 'com.apple.TVWatchList', name: 'TV' },
      playing: { state: 'idle', mediaType: 'unknown', title: null },
      keyboard: { focus: 'unfocused', text: null },
      volume: 50,
      protocols: { companion: true, airplay: true },
      connection: 'connected',
      needsPairing: false,
    });
  });

  it('maps pairing errors: wrong PIN, back-off', async () => {
    const plugin = await realBridgePlugin();
    await eventually(async () => (await plugin.get('/devices')).body.devices.length > 0, 10_000);

    const first = (await plugin.post(`${base}/pair`, { protocol: 'companion' })).body;
    const wrong = await plugin.post(`/pairings/${first.pairingId}/pin`, { pin: '9999' });
    expect([wrong.status, wrong.body.error.code]).toEqual([422, 'PAIRING_FAILED']);

    const second = (await plugin.post(`${base}/pair`, { protocol: 'companion' })).body;
    const backoff = await plugin.post(`/pairings/${second.pairingId}/pin`, { pin: '0000' });
    expect([backoff.status, backoff.body.error.code]).toEqual([429, 'PAIRING_BACKOFF']);
    expect(backoff.body.error.details.retryAfterSec).toBe(30);
    expect(backoff.headers.get('retry-after')).toBe('30');
  });

  it('runs the core loop: open Search, fill, play, wait, volume', async () => {
    const plugin = await realBridgePlugin();
    await pairFake(plugin);

    const apps = (await plugin.get(`${base}/apps`)).body.apps;
    expect(apps.map((a: { name: string }) => a.name)).toEqual(['Netflix', 'Search', 'Settings', 'TV', 'YouTube']);

    const opened = await plugin.post(`${base}/open`, { target: 'Search', waitMs: 5000 });
    expect(opened.body).toMatchObject({ ok: true, foreground: null, app: { bundleId: 'com.apple.TVSearch' } });
    const focused = await plugin.post(`${base}/wait`, { conditions: { keyboard: 'focused' }, timeoutMs: 5000 });
    expect(focused.status).toBe(200);

    const filled = await plugin.post(`${base}/keyboard`, { op: 'set', text: 'stranger' });
    expect(filled.body).toMatchObject({ ok: true, keyboard: { focus: 'focused', text: 'stranger' } });
    const appended = await plugin.post(`${base}/keyboard`, { op: 'append', text: ' things' });
    expect(appended.body.keyboard.text).toBe('stranger things');

    await plugin.post(`${base}/keys`, { keys: [{ key: 'play_pause' }], intervalMs: 0 });
    const playing = await plugin.post(`${base}/wait`, { conditions: { playback: 'playing', text: 'fake movie' }, timeoutMs: 5000 });
    expect(playing.body.state.playing).toMatchObject({ state: 'playing', mediaType: 'video', title: 'Fake Movie', totalTime: 5400 });

    await plugin.post(`${base}/keys`, { keys: [{ key: 'volume_up', count: 2 }], intervalMs: 0 });
    const louder = await plugin.post(`${base}/wait`, { conditions: { idleMs: 0 }, timeoutMs: 1000 });
    expect(louder.status).toBe(200);
    await eventually(async () => (await plugin.get(`${base}/state?refresh=1`)).body.volume === 60, 5000);

    const volume = await plugin.post(`${base}/volume`, { level: 20 });
    expect(volume.body).toMatchObject({ ok: true, volume: 20 });
  });

  it('maps action errors: LAUNCH_FAILED, KEYBOARD_NOT_FOCUSED, DEVICE_OFF', async () => {
    const plugin = await realBridgePlugin();
    await pairFake(plugin);

    const launch = await plugin.post(`${base}/open`, { target: 'com.example.Missing' });
    expect([launch.status, launch.body.error.code]).toEqual([422, 'LAUNCH_FAILED']);

    const keyboard = await plugin.post(`${base}/keyboard`, { op: 'set', text: 'x' });
    expect([keyboard.status, keyboard.body.error.code]).toEqual([409, 'KEYBOARD_NOT_FOCUSED']);

    const off = await plugin.post(`${base}/power`, { on: false });
    expect(off.body).toMatchObject({ ok: true, power: 'off' });
    const key = await plugin.post(`${base}/keys`, { keys: [{ key: 'up' }] });
    expect([key.status, key.body.error.code]).toEqual([409, 'DEVICE_OFF']);
    const shot = await plugin.post(`${base}/screenshot`);
    expect(shot.body.error.code).toBe('SCREEN_NOT_CONFIGURED');
  });

  it('rejects a key action the key does not support before reaching the bridge', async () => {
    const plugin = await realBridgePlugin();
    await pairFake(plugin);

    const response = await plugin.post(`${base}/keys`, { keys: [{ key: 'play', action: 'hold' }] });

    expect([response.status, response.body.error.details.field]).toEqual([400, 'keys[0].action']);
  });
});
