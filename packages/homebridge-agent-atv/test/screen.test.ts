import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEVICE_ID, idlePlaying, installAppleTv, scanDevice } from './support/apple-tv';
import { BridgeFailure, FakeBridge, NO_RESPONSE } from './support/fake-bridge';
import { HOME_FOCUS, RP_IDENTIFIER, UNKNOWN, installScreen, jpeg, type Element } from './support/fake-screen';
import { eventually, makeStorage, seedPairedDevice, startPlugin, stopAll, waitConnected, type Plugin } from './support/harness';

afterEach(stopAll);

type AppleTv = ReturnType<typeof installAppleTv>;

const base = `/devices/${DEVICE_ID}`;
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const NETFLIX: Element = { label: 'Netflix', value: null, identifier: 'app-icon/com.netflix.Netflix' };
const MOVE_HINT = 'move the focus with a direction key (agent-atv press down --settle), or look with agent-atv screenshot';

async function screenPlugin(
  options: {
    paired?: boolean;
    record?: Record<string, unknown>;
    enabled?: boolean;
    env?: NodeJS.ProcessEnv;
    /** How long a launched app takes to reach the foreground; null: it never does. */
    launchMs?: number | null;
  } = {},
) {
  const storagePath = await makeStorage();
  await seedPairedDevice(storagePath, options.record ?? { remotePairing: { identifier: RP_IDENTIFIER } });
  const bridge = new FakeBridge();
  const launchMs = options.launchMs === undefined ? 0 : options.launchMs;
  const tv = installAppleTv(bridge, {
    onLaunch: (app) => {
      if (launchMs !== null) setTimeout(() => (screen.foreground = { kind: 'app', ...app }), launchMs);
    },
  });
  const worker = new FakeBridge();
  const screen = installScreen(worker, { paired: options.paired ?? true });
  const plugin = await startPlugin({
    spawnBridge: bridge.spawn,
    spawnScreen: worker.spawn,
    storagePath,
    config: { screen: { enabled: options.enabled ?? true } },
    ...(options.env ? { env: options.env } : {}),
  });
  await waitConnected(plugin);
  if (options.enabled !== false) await screenIs(plugin, options.paired === false ? 'unpaired' : 'connected');
  return { plugin, bridge, tv, worker, screen, storagePath };
}

async function screenIs(plugin: Plugin, status: string): Promise<void> {
  await eventually(async () => (await plugin.get('/devices')).body.devices[0]?.screen === status);
}

describe('screen worker (P5)', () => {
  it('runs one worker per Apple TV with its address and pair record, pmd3-home as HOME and a scrubbed env', async () => {
    const env = {
      ...process.env,
      AGENT_ATV_FAKE_BRIDGE: '1',
      KEEP_ME: 'yes',
      XDG_DATA_HOME: '/x',
      SUDO_USER: 'admin',
      SUDO_UID: '1000',
      SUDO_GID: '1000',
      PYMOBILEDEVICE3_UDID: 'other',
    };
    const { worker, storagePath } = await screenPlugin({ env });

    expect(worker.spawns).toHaveLength(1);
    const [spawn] = worker.spawns;
    expect(spawn!.args).toEqual(['-u', '-m', 'agent_atv_screen', '--fake', '--address', '192.168.1.50', '--identifier', RP_IDENTIFIER]);
    expect(spawn!.cwd).toBe(path.resolve(__dirname, '..', 'python'));
    expect(spawn!.env.PYTHONPATH).toBe(spawn!.cwd);
    expect(spawn!.env.HOME).toBe(path.join(storagePath, 'agent-atv', 'pmd3-home'));
    expect(existsSync(spawn!.env.HOME!)).toBe(true);
    expect(spawn!.env.KEEP_ME).toBe('yes');
    for (const name of ['XDG_DATA_HOME', 'SUDO_USER', 'SUDO_UID', 'SUDO_GID', 'PYMOBILEDEVICE3_UDID']) {
      expect(spawn!.env[name], name).toBeUndefined();
    }
  });

  it('saves the pair record identifier a worker found by itself (a copied record)', async () => {
    const { storagePath } = await screenPlugin({ record: {} });

    const record = await eventually(async () => {
      const saved = JSON.parse(await readFile(path.join(storagePath, 'agent-atv', 'devices', `${DEVICE_ID}.json`), 'utf8'));
      return saved.remotePairing ? saved : null;
    });
    expect(record.remotePairing).toEqual({ identifier: RP_IDENTIFIER });
  });

  it('reports screen reading in /info and the device summary', async () => {
    const { plugin } = await screenPlugin();

    expect((await plugin.get('/info')).body.screen).toEqual({
      enabled: true,
      status: 'ready',
      ready: true,
      reason: null,
      pymobiledevice3: '11.49.1',
    });
    expect((await plugin.get('/devices')).body.devices[0].screen).toBe('connected');
  });

  it('restarts a worker with the address the Apple TV has now', async () => {
    const { plugin, bridge, worker } = await screenPlugin();
    bridge.handle('scan', () => ({ devices: [scanDevice({ address: '192.168.1.51' })] }));
    await plugin.post('/scan');

    worker.crash();
    await eventually(() => worker.spawns.length === 2, 4000);

    expect(worker.spawns[1]!.args).toContain('192.168.1.51');
  });

  it('logs tunnel changes at info, a reconnect that keeps failing only once', async () => {
    const { plugin, worker } = await screenPlugin();
    const status = (tunnel: string, error: string | null = null) =>
      worker.event('status', undefined, { tunnel, identifier: RP_IDENTIFIER, error });

    status('connecting');
    status('disconnected', 'ConnectionError: not found');
    status('connecting');
    status('disconnected', 'ConnectionError: not found');
    status('connected');
    await eventually(() => plugin.log.at('info').filter((m) => m.includes('screen reading')).length === 4);

    expect(plugin.log.at('info').filter((m) => m.includes('screen reading'))).toEqual([
      'Living Room: screen reading connected',
      'Living Room: screen reading reconnecting',
      'Living Room: screen reading disconnected (ConnectionError: not found); retrying with backoff',
      'Living Room: screen reading connected',
    ]);
  });

  it("logs the screen worker's INFO lines at info and its DEBUG lines at debug", async () => {
    const { plugin, worker } = await screenPlugin();

    worker.logStderr('INFO agent_atv_screen.pmd3: Stopped following the focus (ConnectionError)');
    worker.logStderr('DEBUG agent_atv_screen.pmd3: Closing a session failed');

    await eventually(() => plugin.log.at('debug').some((m) => m.includes('Closing a session failed')));
    expect(plugin.log.at('info')).toContain('screen Living Room: agent_atv_screen.pmd3: Stopped following the focus (ConnectionError)');
  });

  it('restarts a worker that exits', async () => {
    const { plugin, worker } = await screenPlugin();

    worker.crash();
    await eventually(() => worker.spawns.length === 2, 4000);
    await screenIs(plugin, 'connected');
    expect((await plugin.get(`${base}/focus`)).status).toBe(200);
  });
});

describe('POST /screen (P5)', () => {
  it('turns screen reading on without a restart, so pairing gets the screen step', async () => {
    const { plugin, worker } = await screenPlugin({ enabled: false });

    const response = await plugin.post('/screen', { enabled: true });

    expect([response.status, response.body.ok, response.body.screen.enabled]).toEqual([200, true, true]);
    await screenIs(plugin, 'connected');
    expect(worker.spawns).toHaveLength(1);
    expect((await plugin.get(`${base}/focus`)).body.focus).toEqual(HOME_FOCUS);
    const pairing = await plugin.post(`${base}/pair`);
    expect(pairing.body.steps).toBe(3);
    await plugin.request('DELETE', `/pairings/${pairing.body.pairingId}`);
  });

  it('starts nothing twice when screen reading is already on', async () => {
    const { plugin, worker } = await screenPlugin();

    const response = await plugin.post('/screen', { enabled: true });

    expect(response.body.screen).toMatchObject({ enabled: true, status: 'ready' });
    expect(worker.spawns).toHaveLength(1);
  });

  it('only turns it on: turning it off is a settings change', async () => {
    const { plugin } = await screenPlugin();

    const response = await plugin.post('/screen', { enabled: false });

    expect([response.status, response.body.error.details]).toEqual([400, { field: 'enabled' }]);
    expect(response.body.error.hint).toContain('plugin settings');
  });
});

describe('GET /devices/:device/focus (P5)', () => {
  it('returns the focused element', async () => {
    const { plugin } = await screenPlugin();

    const response = await plugin.get(`${base}/focus`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ focus: HOME_FOCUS, durationMs: expect.any(Number) });
  });

  it('answers FOCUS_UNKNOWN, with what to do, until tvOS has moved the focus', async () => {
    const { plugin, screen } = await screenPlugin();
    screen.reads = [UNKNOWN];

    const response = await plugin.get(`${base}/focus`);

    expect([response.status, response.body.error.code]).toEqual([409, 'FOCUS_UNKNOWN']);
    expect(response.body.error.hint).toBe(MOVE_HINT);
  });

  it.each([
    ['now-playing app', (tv: AppleTv) => (tv.state.nowPlaying = { bundleId: 'com.netflix.Netflix', name: 'Netflix' })],
    ['playback', (tv: AppleTv) => (tv.state.playing = { ...idlePlaying(), state: 'loading', mediaType: 'video' })],
  ])('answers FOCUS_UNKNOWN once the %s changed after the focus last moved, until it moves again', async (_name, change) => {
    const { plugin, tv, screen } = await screenPlugin();
    screen.movedAt = Date.now() - 5000;

    change(tv);
    tv.push();
    await eventually(async () => (await plugin.get(`${base}/state`)).body.seq > 2);

    expect((await plugin.get(`${base}/focus`)).body.error.code).toBe('FOCUS_UNKNOWN');
    expect((await plugin.get(`${base}/state?focus=1`)).body.focus).toMatchObject({ available: false, code: 'FOCUS_UNKNOWN' });
    screen.movedAt = Date.now();
    expect((await plugin.get(`${base}/focus`)).body.focus).toEqual(HOME_FOCUS);
  });

  it('answers SCREEN_NOT_PAIRED with the command that pairs screen reading', async () => {
    const { plugin } = await screenPlugin({ paired: false });

    const response = await plugin.get(`${base}/focus`);

    expect([response.status, response.body.error.code]).toEqual([503, 'SCREEN_NOT_PAIRED']);
    expect(response.body.error.hint).toBe(`run agent-atv pair ${DEVICE_ID} --screen`);
  });

  it('answers SCREEN_NOT_CONFIGURED while screen reading is off, without a worker', async () => {
    const { plugin, worker } = await screenPlugin({ enabled: false });

    const response = await plugin.get(`${base}/focus`);

    expect([response.status, response.body.error.code]).toEqual([503, 'SCREEN_NOT_CONFIGURED']);
    expect(response.body.error.hint).toBe('enable "Screen reading" in the agent-atv plugin settings');
    expect(worker.spawns).toEqual([]);
  });

  it('answers DEVICE_OFF while the Apple TV is off', async () => {
    const { plugin, tv, screen } = await screenPlugin();
    tv.state.power = 'off';
    tv.push();
    await eventually(async () => (await plugin.get(`${base}/state`)).body.power === 'off');

    const response = await plugin.get(`${base}/focus`);

    expect([response.status, response.body.error.code]).toEqual([409, 'DEVICE_OFF']);
    expect(response.body.error.hint).toBe('turn it on: agent-atv power on');
    expect(screen.focusReads).toBe(0);
  });

  it('reports the focus as unavailable at once in the state while the tunnel reconnects', async () => {
    const { plugin, screen } = await screenPlugin();
    screen.tunnel = 'connecting';
    screen.push();
    await screenIs(plugin, 'connecting');

    const started = Date.now();
    const response = await plugin.get(`${base}/state?refresh=1&focus=1`);

    expect(response.body.focus).toMatchObject({ available: false, code: 'SCREEN_UNAVAILABLE', hint: 'retry in a few seconds' });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(screen.focusReads).toBe(0);
  });

  it('adds a focus report to the state with ?focus=1', async () => {
    const { plugin } = await screenPlugin();

    const response = await plugin.get(`${base}/state?refresh=1&focus=1`);

    expect(response.body.focus).toEqual({ available: true, element: HOME_FOCUS });
    expect((await plugin.get(`${base}/state`)).body).not.toHaveProperty('focus');
  });
});

describe('focus after actions (P5)', () => {
  it('reports the focus once it settles: at least 300 ms after the action, two equal reads', async () => {
    const { plugin, screen } = await screenPlugin();
    screen.reads = [HOME_FOCUS, NETFLIX, NETFLIX];

    const started = Date.now();
    const response = await plugin.post(`${base}/keys`, { keys: [{ key: 'right' }], focus: true });

    expect(response.body).toMatchObject({ ok: true, pressed: 1, focus: { available: true, element: NETFLIX } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(screen.focusReads).toBe(3);
  });

  it('stops reading after about a second when the focus keeps moving', async () => {
    const { plugin, screen } = await screenPlugin();
    const moving = Array.from({ length: 200 }, (_, i) => ({ label: `tile ${i}`, value: null, identifier: `tile-${i}` }));
    screen.reads = moving;

    const started = Date.now();
    const response = await plugin.post(`${base}/keys`, { keys: [{ key: 'right' }], focus: true });

    expect(Date.now() - started).toBeLessThan(1500);
    expect(response.body.focus.available).toBe(true);
    expect(response.body.focus.element.label).toMatch(/^tile \d+$/);
  });

  it.each([
    ['open', '/open', { target: 'com.netflix.Netflix', waitMs: 0, focus: true }],
    ['keyboard', '/keyboard', { op: 'clear', focus: true }],
  ])('reports it after %s too', async (_name, route, body) => {
    const { plugin, tv } = await screenPlugin();
    tv.state.keyboard = { focus: 'focused', text: 'x' };

    const response = await plugin.post(`${base}${route}`, body);

    expect(response.body.focus).toEqual({ available: true, element: HOME_FOCUS });
  });

  it('says the focus is not known when tvOS reported no move after the keys', async () => {
    const { plugin, screen } = await screenPlugin();
    screen.movedAt = Date.now() - 60_000;

    const started = Date.now();
    const response = await plugin.post(`${base}/keys`, { keys: [{ key: 'select' }], focus: true });

    expect(response.status).toBe(200);
    expect(response.body.focus).toEqual({ available: false, code: 'FOCUS_UNKNOWN', reason: 'focus not known', hint: MOVE_HINT });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('does not take a move made just before the keys for one they caused, however slow the reply', async () => {
    const { plugin, screen } = await screenPlugin();
    screen.movedAt = Date.now() - 20;
    screen.replyDelayMs = 200;

    const response = await plugin.post(`${base}/keys`, { keys: [{ key: 'select' }], focus: true });

    expect(response.body.focus).toMatchObject({ available: false, code: 'FOCUS_UNKNOWN' });
  });

  it('waits within the settle window for a move tvOS reports late', async () => {
    const { plugin, screen } = await screenPlugin();
    screen.movedAt = Date.now() - 60_000;
    setTimeout(() => {
      screen.reads = [NETFLIX];
      screen.movedAt = Date.now();
    }, 500);

    const response = await plugin.post(`${base}/keys`, { keys: [{ key: 'right' }], focus: true });

    expect(response.body.focus).toEqual({ available: true, element: NETFLIX });
  });

  it('waits within the settle window while the focus is unknown after a screen change', async () => {
    const { plugin, screen } = await screenPlugin();
    screen.reads = [UNKNOWN];
    setTimeout(() => (screen.reads = [NETFLIX]), 500);

    const response = await plugin.post(`${base}/keys`, { keys: [{ key: 'select' }], focus: true });

    expect(response.body.focus).toEqual({ available: true, element: NETFLIX });
  });

  it('never reports an element read before the screen changed, even when it was the last one', async () => {
    const { plugin, screen } = await screenPlugin();
    screen.reads = [HOME_FOCUS, UNKNOWN];

    const response = await plugin.post(`${base}/keys`, { keys: [{ key: 'select' }], focus: true });

    expect(response.body.focus).toMatchObject({ available: false, code: 'FOCUS_UNKNOWN' });
  });

  it('after typing, reports the element focused before (typing does not move the focus)', async () => {
    const { plugin, tv, screen } = await screenPlugin();
    tv.state.keyboard = { focus: 'focused', text: '' };
    screen.movedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const response = await plugin.post(`${base}/keyboard`, { op: 'append', text: 'a', focus: true });

    expect(response.body.focus).toEqual({ available: true, element: HOME_FOCUS });
  });

  it('gives up on a focus read that hangs, within the settle cap', async () => {
    const { plugin, worker } = await screenPlugin();
    worker.handle('focus', () => NO_RESPONSE);

    const started = Date.now();
    const response = await plugin.post(`${base}/keys`, { keys: [{ key: 'right' }], focus: true });

    expect(response.status).toBe(200);
    expect(response.body.focus).toMatchObject({ available: false, code: 'SCREEN_UNAVAILABLE' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it.each([
    ['keys', '/keys', { keys: [{ key: 'up' }] }],
    ['open', '/open', { target: 'com.netflix.Netflix', waitMs: 0 }],
    ['keyboard', '/keyboard', { op: 'clear' }],
  ])('%s reads no focus unless the body asks for it', async (_name, route, body) => {
    const { plugin, tv, screen } = await screenPlugin();
    tv.state.keyboard = { focus: 'focused', text: 'x' };

    const started = Date.now();
    const plain = await plugin.post(`${base}${route}`, body);
    const declined = await plugin.post(`${base}${route}`, { ...body, focus: false });

    for (const response of [plain, declined]) {
      expect(response.status).toBe(200);
      expect(response.body).not.toHaveProperty('focus');
    }
    expect(screen.focusReads).toBe(0);
    expect(Date.now() - started).toBeLessThan(300);
  });

  it('rejects a focus field that is not a boolean', async () => {
    const { plugin } = await screenPlugin();

    const response = await plugin.post(`${base}/keys`, { keys: [{ key: 'up' }], focus: 'yes' });

    expect([response.status, response.body.error.details]).toEqual([400, { field: 'focus' }]);
  });

  it('says at once what to do when screen reading is not paired, and the action still succeeds', async () => {
    const { plugin, bridge } = await screenPlugin({ paired: false });

    const started = Date.now();
    const response = await plugin.post(`${base}/keys`, { keys: [{ key: 'up' }], focus: true });

    expect(response.status).toBe(200);
    expect(bridge.calls('key')).toHaveLength(1);
    expect(response.body.focus).toEqual({
      available: false,
      code: 'SCREEN_NOT_PAIRED',
      reason: 'screen reading not paired',
      hint: `run agent-atv pair ${DEVICE_ID} --screen`,
    });
    expect(Date.now() - started).toBeLessThan(300);
  });

  it('says the focus is not known when the worker does not know it', async () => {
    const { plugin, screen } = await screenPlugin();
    screen.reads = [UNKNOWN];

    const response = await plugin.post(`${base}/keys`, { keys: [{ key: 'play_pause' }], focus: true });

    expect(response.status).toBe(200);
    expect(response.body.focus).toEqual({ available: false, code: 'FOCUS_UNKNOWN', reason: 'focus not known', hint: MOVE_HINT });
  });

  it('says screen reading is off when it is disabled', async () => {
    const { plugin } = await screenPlugin({ enabled: false });

    const response = await plugin.post(`${base}/keys`, { keys: [{ key: 'up' }], focus: true });

    expect(response.body.focus).toEqual({
      available: false,
      code: 'SCREEN_NOT_CONFIGURED',
      reason: 'screen reading off',
      hint: 'enable "Screen reading" in the agent-atv plugin settings',
    });
  });

  it('says to retry while the tunnel reconnects', async () => {
    const { plugin, screen } = await screenPlugin();
    screen.tunnel = 'connecting';
    screen.push();
    await screenIs(plugin, 'connecting');

    const response = await plugin.post(`${base}/keys`, { keys: [{ key: 'up' }], focus: true });

    expect(response.body.focus).toEqual({
      available: false,
      code: 'SCREEN_UNAVAILABLE',
      reason: 'screen reading not connected',
      hint: 'retry in a few seconds',
    });
  });
});

describe('POST /devices/:device/screenshot (P5)', () => {
  it('returns the PNG the worker wrote, with its headers, and deletes the temp file', async () => {
    const { plugin, worker, screen } = await screenPlugin();

    const response = await plugin.post(`${base}/screenshot`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.raw).toEqual(screen.image);
    expect(response.headers.get('x-agent-atv-sha256')).toBe(sha256(screen.image));
    expect(response.headers.get('x-agent-atv-width')).toBe('3840');
    expect(response.headers.get('x-agent-atv-height')).toBe('2160');
    expect(response.headers.get('x-agent-atv-captured-at')).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(Number(response.headers.get('x-agent-atv-duration-ms'))).toBeGreaterThanOrEqual(0);
    const written = String(worker.calls('screenshot')[0]?.path);
    expect(path.dirname(written!)).toBe(tmpdir());
    expect(existsSync(written!)).toBe(false);
  });

  it('answers 304 when ifNoneMatch is the sha256 of the new capture', async () => {
    const { plugin } = await screenPlugin();
    const first = await plugin.post(`${base}/screenshot`);

    const same = await plugin.post(`${base}/screenshot`, { ifNoneMatch: first.headers.get('x-agent-atv-sha256') });
    expect([same.status, same.raw.length]).toEqual([304, 0]);

    expect((await plugin.post(`${base}/screenshot`, { ifNoneMatch: 'f'.repeat(64) })).status).toBe(200);
  });

  it('asks the worker for a scaled-down JPEG and returns it as image/jpeg with its size', async () => {
    const { plugin, worker, screen } = await screenPlugin();
    screen.image = jpeg(1280, 720);

    const response = await plugin.post(`${base}/screenshot`, { maxWidth: 1280, format: 'jpeg' });

    expect(worker.calls('screenshot')[0]).toMatchObject({ maxWidth: 1280, format: 'jpeg' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.raw).toEqual(screen.image);
    expect(response.headers.get('x-agent-atv-sha256')).toBe(sha256(screen.image));
    expect([response.headers.get('x-agent-atv-width'), response.headers.get('x-agent-atv-height')]).toEqual(['1280', '720']);
    const same = await plugin.post(`${base}/screenshot`, { maxWidth: 1280, format: 'jpeg', ifNoneMatch: sha256(screen.image) });
    expect(same.status).toBe(304);
  });

  it('rejects a maxWidth out of range or an unknown format before asking the worker', async () => {
    const { plugin, worker } = await screenPlugin();

    const narrow = await plugin.post(`${base}/screenshot`, { maxWidth: 100 });
    const gif = await plugin.post(`${base}/screenshot`, { format: 'gif' });

    expect([narrow.status, narrow.body.error.code, narrow.body.error.details]).toEqual([400, 'BAD_REQUEST', { field: 'maxWidth' }]);
    expect(narrow.body.error.message).toBe('maxWidth must be an integer from 160 to 3840');
    expect(narrow.body.error.hint).toBe('Pass a width from 160 to 3840, e.g. agent-atv screenshot --max-width 1280 --jpeg');
    expect([gif.status, gif.body.error.details]).toEqual([400, { field: 'format' }]);
    expect(worker.calls('screenshot')).toEqual([]);
  });

  it('answers SCREEN_FAILED when the worker writes something other than the JPEG asked for', async () => {
    const { plugin } = await screenPlugin();

    const response = await plugin.post(`${base}/screenshot`, { format: 'jpeg' });

    expect([response.status, response.body.error.code]).toEqual([502, 'SCREEN_FAILED']);
  });

  it('answers SCREEN_FAILED when the worker writes something that is not a PNG', async () => {
    const { plugin, screen } = await screenPlugin();
    screen.image = Buffer.from('not a png');

    const response = await plugin.post(`${base}/screenshot`);

    expect([response.status, response.body.error.code]).toEqual([502, 'SCREEN_FAILED']);
  });

  it('passes worker failures through with a hint', async () => {
    const { plugin, worker } = await screenPlugin();
    worker.handle('screenshot', () => {
      throw new BridgeFailure('SCREEN_UNAVAILABLE', 'No tunnel to the Apple TV (ConnectionError: not found)', { tunnel: 'disconnected' });
    });

    const response = await plugin.post(`${base}/screenshot`);

    expect([response.status, response.body.error.code]).toEqual([503, 'SCREEN_UNAVAILABLE']);
    expect(response.body.error.hint).toBe('wake the Apple TV with agent-atv power on, then retry');
  });
});

describe('wait for a focused element (P5)', () => {
  it('polls the focus until its label, value or identifier contains the text', async () => {
    const { plugin, screen } = await screenPlugin();
    screen.reads = [HOME_FOCUS, HOME_FOCUS, NETFLIX];

    const response = await plugin.post(`${base}/wait`, { conditions: { focus: 'com.netflix' }, timeoutMs: 5000 });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, matched: ['focus'], focus: NETFLIX });
  });

  it('keeps polling while the focus is not known yet', async () => {
    const { plugin, screen } = await screenPlugin();
    screen.reads = [UNKNOWN, UNKNOWN, NETFLIX];

    const response = await plugin.post(`${base}/wait`, { conditions: { focus: 'netflix' }, timeoutMs: 5000 });

    expect(response.body).toMatchObject({ ok: true, matched: ['focus'], focus: NETFLIX });
  });

  it('never matches a focus that became unknown while waiting', async () => {
    const { plugin, tv, screen } = await screenPlugin();
    screen.reads = [NETFLIX];
    screen.movedAt = Date.now();
    setTimeout(() => {
      tv.state.nowPlaying = { bundleId: 'com.netflix.Netflix', name: 'Netflix' };
      tv.push();
      screen.foreground = { kind: 'app', bundleId: 'com.netflix.Netflix', name: 'Netflix' };
    }, 300);

    const response = await plugin.post(`${base}/wait`, { conditions: { focus: 'netflix', app: 'com.netflix.Netflix' }, timeoutMs: 1200 });

    expect([response.status, response.body.error.code]).toEqual([408, 'WAIT_TIMEOUT']);
    expect(response.body.error.details).toMatchObject({ pending: ['focus'], focus: null });
  });

  it('times out with the last focus in the details', async () => {
    const { plugin } = await screenPlugin();

    const response = await plugin.post(`${base}/wait`, { conditions: { focus: 'netflix' }, timeoutMs: 600 });

    expect([response.status, response.body.error.code]).toEqual([408, 'WAIT_TIMEOUT']);
    expect(response.body.error.details).toMatchObject({ pending: ['focus'], focus: HOME_FOCUS });
  });

  it('fails at once when screen reading is not paired', async () => {
    const { plugin } = await screenPlugin({ paired: false });

    const response = await plugin.post(`${base}/wait`, { conditions: { focus: 'netflix' }, timeoutMs: 5000 });

    expect([response.status, response.body.error.code]).toEqual([503, 'SCREEN_NOT_PAIRED']);
  });
});

const NETFLIX_APP = { kind: 'app', bundleId: 'com.netflix.Netflix', name: 'Netflix' } as const;
const SCREEN_OFF = {
  available: false,
  code: 'SCREEN_NOT_CONFIGURED',
  reason: 'screen reading off',
  hint: 'enable "Screen reading" in the agent-atv plugin settings',
};

describe('foreground app in the state (P5)', () => {
  it.each([
    ['an app', NETFLIX_APP],
    ['the home screen', { kind: 'home' }],
    ['the screensaver', { kind: 'screensaver' }],
    ['several apps', { kind: 'ambiguous', apps: [{ bundleId: 'com.apple.TVSettings', name: 'Settings' }, NETFLIX_APP] }],
  ] as const)('adds what the worker reads to the state with ?app=1: %s', async (_name, foreground) => {
    const { plugin, screen } = await screenPlugin();
    screen.foreground = structuredClone(foreground) as never;

    const response = await plugin.get(`${base}/state?refresh=1&app=1`);

    expect(response.body.app).toEqual({ available: true, ...foreground });
  });

  it('reads nothing without ?app=1 and never takes the now-playing app for the foreground one', async () => {
    const { plugin, screen } = await screenPlugin();

    const body = (await plugin.get(`${base}/state`)).body;

    expect(body).not.toHaveProperty('app');
    expect(body.nowPlaying).toEqual({ bundleId: 'com.apple.TVWatchList', name: 'TV' });
    expect(screen.foregroundReads).toBe(0);
  });

  it('reports the app as unavailable, with the fix, while screen reading is off or not paired', async () => {
    const off = await screenPlugin({ enabled: false });
    expect((await off.plugin.get(`${base}/state?app=1`)).body.app).toEqual(SCREEN_OFF);

    const unpaired = await screenPlugin({ paired: false });
    expect((await unpaired.plugin.get(`${base}/state?app=1`)).body.app).toEqual({
      available: false,
      code: 'SCREEN_NOT_PAIRED',
      reason: 'screen reading not paired',
      hint: `run agent-atv pair ${DEVICE_ID} --screen`,
    });
  });
});

describe('open with the foreground app (P5)', () => {
  it('waits until the launched app is in the foreground, reading it about every 500 ms', async () => {
    const { plugin, screen } = await screenPlugin({ launchMs: 1200 });
    const started = Date.now();

    const response = await plugin.post(`${base}/open`, { target: 'Netflix' });

    expect(response.body).toMatchObject({ ok: true, foreground: true, app: { bundleId: 'com.netflix.Netflix', name: 'Netflix' } });
    expect(response.body).not.toHaveProperty('foregroundUnknown');
    expect(Date.now() - started).toBeGreaterThanOrEqual(1200);
    expect(screen.foregroundReads).toBeLessThanOrEqual(5);
  });

  it('answers 200 with foreground false when the app is not in the foreground within waitMs', async () => {
    const { plugin } = await screenPlugin({ launchMs: null });
    const started = Date.now();

    const response = await plugin.post(`${base}/open`, { target: 'Netflix', waitMs: 600 });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, foreground: false, app: { bundleId: 'com.netflix.Netflix' } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(590);
  });

  it('returns at once, with the fix, when screen reading is not paired', async () => {
    const { plugin } = await screenPlugin({ paired: false, launchMs: null });
    const started = Date.now();

    const response = await plugin.post(`${base}/open`, { target: 'Netflix' });

    expect(response.body).toMatchObject({
      ok: true,
      foreground: null,
      foregroundUnknown: { code: 'SCREEN_NOT_PAIRED', hint: `run agent-atv pair ${DEVICE_ID} --screen` },
    });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('reads again after a read that failed', async () => {
    const { plugin, screen } = await screenPlugin();
    screen.foregroundFailures = 2;

    const response = await plugin.post(`${base}/open`, { target: 'Netflix', waitMs: 3000 });

    expect(response.body).toMatchObject({ ok: true, foreground: true });
  });

  it('returns at once while the tunnel reconnects, saying how to check without opening again', async () => {
    const { plugin, screen } = await screenPlugin();
    screen.tunnel = 'connecting';
    screen.push();
    await screenIs(plugin, 'connecting');

    const response = await plugin.post(`${base}/open`, { target: 'Netflix' });

    expect(response.body).toMatchObject({
      foreground: null,
      foregroundUnknown: {
        code: 'SCREEN_UNAVAILABLE',
        reason: 'screen reading not connected',
        hint: 'check in a few seconds with agent-atv wait --app com.netflix.Netflix',
      },
    });
  });

  it('reads nothing with waitMs 0', async () => {
    const { plugin, screen } = await screenPlugin();

    const response = await plugin.post(`${base}/open`, { target: 'Netflix', waitMs: 0 });

    expect(response.body).toMatchObject({ ok: true, foreground: false });
    expect(screen.foregroundReads).toBe(0);
  });
});

describe('wait for the foreground app (P5)', () => {
  it('reads the foreground app until it matches the bundle id or the name, case-insensitively', async () => {
    const { plugin, screen } = await screenPlugin();
    setTimeout(() => (screen.foreground = NETFLIX_APP), 700);

    const byName = await plugin.post(`${base}/wait`, { conditions: { app: 'netflix' }, timeoutMs: 5000 });
    const byId = await plugin.post(`${base}/wait`, { conditions: { app: 'com.netflix.Netflix' }, timeoutMs: 5000 });

    expect(byName.body).toMatchObject({ ok: true, matched: ['app'], app: NETFLIX_APP });
    expect(byName.body.elapsedMs).toBeGreaterThanOrEqual(690);
    expect(byId.body).toMatchObject({ ok: true, matched: ['app'] });
  });

  it('matches the home screen as home and the screensaver as screensaver, case-insensitively', async () => {
    const { plugin, screen } = await screenPlugin();
    screen.foreground = { kind: 'home' };
    const home = await plugin.post(`${base}/wait`, { conditions: { app: 'Home' }, timeoutMs: 3000 });
    screen.foreground = { kind: 'screensaver' };
    const screensaver = await plugin.post(`${base}/wait`, { conditions: { app: 'Screensaver' }, timeoutMs: 3000 });
    const notHome = await plugin.post(`${base}/wait`, { conditions: { app: 'home' }, timeoutMs: 700 });

    expect(home.body).toMatchObject({ ok: true, matched: ['app'] });
    expect(screensaver.body).toMatchObject({ ok: true, matched: ['app'] });
    expect([notHome.status, notHome.body.error.code]).toEqual([408, 'WAIT_TIMEOUT']);
  });

  it('keeps reading when the first read finds nothing but the shell in front', async () => {
    const { plugin, screen } = await screenPlugin();
    screen.foreground = NETFLIX_APP;
    screen.foregroundFailures = 1;

    const response = await plugin.post(`${base}/wait`, { conditions: { app: 'netflix' }, timeoutMs: 3000 });

    expect(response.body).toMatchObject({ ok: true, matched: ['app'] });
  });

  it('never matches an app that shares the foreground with another one', async () => {
    const { plugin, screen } = await screenPlugin();
    screen.foreground = { kind: 'ambiguous', apps: [{ bundleId: 'com.apple.TVSettings', name: 'Settings' }, NETFLIX_APP] };

    const response = await plugin.post(`${base}/wait`, { conditions: { app: 'netflix' }, timeoutMs: 700 });

    expect([response.status, response.body.error.code]).toEqual([408, 'WAIT_TIMEOUT']);
    expect(response.body.error.details).toMatchObject({ pending: ['app'], app: screen.foreground });
  });

  it('fails at once when screen reading is not paired', async () => {
    const { plugin } = await screenPlugin({ paired: false });

    const response = await plugin.post(`${base}/wait`, { conditions: { app: 'netflix' }, timeoutMs: 5000 });

    expect([response.status, response.body.error.code]).toEqual([503, 'SCREEN_NOT_PAIRED']);
  });
});
