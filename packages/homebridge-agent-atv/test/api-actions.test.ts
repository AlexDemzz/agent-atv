import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { APPS, DEVICE_ID, installAppleTv, type AppleTvOptions } from './support/apple-tv';
import { FakeBridge } from './support/fake-bridge';
import { makeStorage, seedPairedDevice, startPlugin, stopAll, waitConnected } from './support/harness';

afterEach(stopAll);

async function connectedPlugin(options: AppleTvOptions = {}) {
  const storagePath = await makeStorage();
  await seedPairedDevice(storagePath);
  const bridge = new FakeBridge();
  const tv = installAppleTv(bridge, options);
  const plugin = await startPlugin({ spawnBridge: bridge.spawn, storagePath });
  await waitConnected(plugin);
  return { plugin, bridge, tv, storagePath };
}

const base = `/devices/${DEVICE_ID}`;

describe('apps (P1)', () => {
  it('lists apps once, serves the cache afterwards, persists it, and refetches on ?refresh=1', async () => {
    const { plugin, bridge, storagePath } = await connectedPlugin();

    expect((await plugin.get(`${base}/apps`)).body).toEqual({ apps: APPS });
    await plugin.get(`${base}/apps`);
    expect(bridge.calls('apps.list')).toHaveLength(1);

    const record = JSON.parse(await readFile(path.join(storagePath, 'agent-atv', 'devices', `${DEVICE_ID}.json`), 'utf8'));
    expect(record.apps.list).toEqual(APPS);
    expect(record.apps.fetchedAt).toMatch(/Z$/);

    await plugin.get(`${base}/apps?refresh=1`);
    expect(bridge.calls('apps.list')).toHaveLength(2);
  });
});

describe('open (P1)', () => {
  it('resolves an app name and launches its bundle id; without screen reading it returns at once with the fix', async () => {
    const { plugin, bridge } = await connectedPlugin();
    const started = Date.now();

    const response = await plugin.post(`${base}/open`, { target: 'netflix' });

    expect(response.status).toBe(200);
    expect(bridge.calls('app.launch')).toEqual([{ device: DEVICE_ID, target: 'com.netflix.Netflix' }]);
    expect(response.body).toMatchObject({
      ok: true,
      app: { bundleId: 'com.netflix.Netflix', name: 'Netflix' },
      foreground: null,
      foregroundUnknown: {
        code: 'SCREEN_NOT_CONFIGURED',
        reason: 'screen reading off',
        hint: 'enable "Screen reading" in the agent-atv plugin settings',
      },
    });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('resolves a unique prefix and launches a bundle id as is', async () => {
    const { plugin, bridge } = await connectedPlugin();

    await plugin.post(`${base}/open`, { target: 'You' });
    await plugin.post(`${base}/open`, { target: 'com.apple.TVSettings' });

    expect(bridge.calls('app.launch').map((p) => p.target)).toEqual(['com.google.ios.youtube', 'com.apple.TVSettings']);
  });

  it('reports APP_NOT_FOUND and AMBIGUOUS_APP for names', async () => {
    const { plugin, bridge } = await connectedPlugin();

    const missing = await plugin.post(`${base}/open`, { target: 'Disney' });
    expect([missing.status, missing.body.error.code]).toEqual([404, 'APP_NOT_FOUND']);

    const ambiguous = await plugin.post(`${base}/open`, { target: 'Se' });
    expect([ambiguous.status, ambiguous.body.error.code]).toEqual([409, 'AMBIGUOUS_APP']);
    expect(ambiguous.body.error.details.matches).toEqual([
      { bundleId: 'com.apple.TVSearch', name: 'Search' },
      { bundleId: 'com.apple.TVSettings', name: 'Settings' },
    ]);
    expect(bridge.calls('app.launch')).toEqual([]);
  });

  it('launches URLs without waiting', async () => {
    const { plugin, bridge } = await connectedPlugin();

    const response = await plugin.post(`${base}/open`, { target: 'https://www.netflix.com/title/80057281' });

    expect(response.body).toMatchObject({ ok: true, app: null, foreground: false });
    expect(bridge.calls('app.launch')).toEqual([{ device: DEVICE_ID, target: 'https://www.netflix.com/title/80057281' }]);
  });

  it('passes LAUNCH_FAILED through with 422 and validates waitMs', async () => {
    const { plugin } = await connectedPlugin();

    const failed = await plugin.post(`${base}/open`, { target: 'com.example.Missing' });
    expect([failed.status, failed.body.error.code]).toEqual([422, 'LAUNCH_FAILED']);

    const invalid = await plugin.post(`${base}/open`, { target: 'Netflix', waitMs: 60001 });
    expect([invalid.status, invalid.body.error.details.field]).toEqual([400, 'waitMs']);
  });
});

describe('keyboard, power, volume, seek (P1)', () => {
  it('reads and edits the focused text field', async () => {
    const { plugin, tv } = await connectedPlugin();
    tv.state.keyboard = { focus: 'focused', text: '' };

    expect((await plugin.get(`${base}/keyboard`)).body).toEqual({ focus: 'focused', text: '' });
    await plugin.post(`${base}/keyboard`, { op: 'set', text: 'stranger' });
    const appended = await plugin.post(`${base}/keyboard`, { op: 'append', text: ' things' });

    expect(appended.body).toMatchObject({
      ok: true,
      keyboard: { focus: 'focused', text: 'stranger things' },
      state: { keyboard: { focus: 'focused', text: 'stranger things' } },
    });
    const cleared = await plugin.post(`${base}/keyboard`, { op: 'clear' });
    expect(cleared.body.keyboard.text).toBe('');
  });

  it('answers KEYBOARD_NOT_FOCUSED with 409 and a hint naming the CLI', async () => {
    const { plugin } = await connectedPlugin();

    const response = await plugin.post(`${base}/keyboard`, { op: 'set', text: 'x' });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatchObject({
      code: 'KEYBOARD_NOT_FOCUSED',
      message: 'No text field is focused on Living Room',
      hint: 'Navigate to a text field and press select, then retry. Check with: agent-atv state keyboard',
    });
  });

  it('validates keyboard ops', async () => {
    const { plugin } = await connectedPlugin();

    const badOp = await plugin.post(`${base}/keyboard`, { op: 'replace', text: 'x' });
    expect(badOp.body.error.details.field).toBe('op');
    const noText = await plugin.post(`${base}/keyboard`, { op: 'append' });
    expect(noText.body.error.details.field).toBe('text');
  });

  it('sets power, volume and position', async () => {
    const { plugin, bridge } = await connectedPlugin();

    const power = await plugin.post(`${base}/power`, { on: false });
    expect(power.body).toMatchObject({ ok: true, power: 'off', state: { power: 'off' } });

    const volume = await plugin.post(`${base}/volume`, { level: 40 });
    expect(volume.body).toMatchObject({ ok: true, volume: 40, state: { volume: 40 } });

    const seek = await plugin.post(`${base}/seek`, { position: 754 });
    expect(seek.body).toMatchObject({ ok: true });
    expect(bridge.calls('seek')).toEqual([{ device: DEVICE_ID, position: 754 }]);
  });

  it.each([
    ['power', { on: 'yes' }, 'on'],
    ['volume', { level: 101 }, 'level'],
    ['volume', { level: 2.5 }, 'level'],
    ['seek', { position: -1 }, 'position'],
  ])('rejects invalid %s body %j', async (route, body, field) => {
    const { plugin } = await connectedPlugin();

    const response = await plugin.post(`${base}/${route}`, body);

    expect(response.status).toBe(400);
    expect(response.body.error.details.field).toBe(field);
  });
});
