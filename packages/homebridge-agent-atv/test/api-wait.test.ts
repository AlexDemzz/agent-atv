import { afterEach, describe, expect, it } from 'vitest';
import { DEVICE_ID, installAppleTv } from './support/apple-tv';
import { FakeBridge, delay } from './support/fake-bridge';
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

const wait = `/devices/${DEVICE_ID}/wait`;

describe('POST /devices/:device/wait (P1)', () => {
  it('resolves when every condition holds together, listing them as matched', async () => {
    const { plugin, tv } = await connectedPlugin();
    setTimeout(() => {
      tv.state.nowPlaying = { bundleId: 'com.netflix.Netflix', name: 'Netflix' };
      tv.push();
    }, 50);
    setTimeout(() => {
      tv.state.playing = { ...tv.state.playing, state: 'playing', title: 'Chapter One', seriesName: 'Stranger Things' };
      tv.push();
    }, 150);

    const response = await plugin.post(wait, {
      conditions: { text: 'netflix', playback: 'playing', power: 'on' },
      timeoutMs: 3000,
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      matched: ['text', 'playback', 'power'],
      state: { nowPlaying: { bundleId: 'com.netflix.Netflix' }, playing: { state: 'playing' } },
    });
    expect(response.body.elapsedMs).toBeGreaterThanOrEqual(140);
    expect(response.body.elapsedMs).toBeLessThan(1500);
  });

  it('matches text against the keyboard text, case-insensitively', async () => {
    const { plugin, tv } = await connectedPlugin();
    tv.state.keyboard = { focus: 'focused', text: 'Stranger' };
    tv.push();

    const response = await plugin.post(wait, { conditions: { keyboard: 'focused', text: 'STRAN' }, timeoutMs: 1000 });

    expect(response.status).toBe(200);
    expect(response.body.matched).toEqual(['keyboard', 'text']);
  });

  it('waits at least idleMs, restarting the idle clock on every State change', async () => {
    const { plugin, tv } = await connectedPlugin();
    setTimeout(() => {
      tv.state.volume = 55;
      tv.push();
    }, 200);

    const response = await plugin.post(wait, { conditions: { idleMs: 300 }, timeoutMs: 3000 });

    expect(response.status).toBe(200);
    expect(response.body.matched).toEqual(['idleMs']);
    expect(response.body.elapsedMs).toBeGreaterThanOrEqual(480);
  });

  it('times out with 408 WAIT_TIMEOUT, the pending conditions and the current State', async () => {
    const { plugin } = await connectedPlugin();

    const response = await plugin.post(wait, { conditions: { playback: 'playing', power: 'on' }, timeoutMs: 300 });

    expect(response.status).toBe(408);
    expect(response.body.error).toMatchObject({
      code: 'WAIT_TIMEOUT',
      message: 'Timed out after 300ms waiting for playback=playing',
      details: { pending: ['playback'], state: { playing: { state: 'idle' }, connection: 'connected' } },
    });
    expect(response.body.error.details.elapsedMs).toBeGreaterThanOrEqual(300);
  });

  it('fails at once on an app condition while screen reading is off, with the fix', async () => {
    const { plugin } = await connectedPlugin();

    const response = await plugin.post(wait, { conditions: { app: 'com.netflix.Netflix' }, timeoutMs: 5000 });

    expect([response.status, response.body.error.code]).toEqual([503, 'SCREEN_NOT_CONFIGURED']);
    expect(response.body.error.hint).toBe('enable "Screen reading" in the agent-atv plugin settings');
  });

  it('keeps waiting through a dropped connection', async () => {
    const { plugin, tv } = await connectedPlugin();
    setTimeout(() => tv.dropConnection(), 30);
    setTimeout(() => {
      tv.state.power = 'off';
      tv.push();
    }, 200);

    const response = await plugin.post(wait, { conditions: { power: 'off' }, timeoutMs: 2000 });

    expect(response.status).toBe(200);
    expect(response.body.state.power).toBe('off');
  });

  it.each([
    [{ conditions: {} }, 'conditions'],
    [{}, 'conditions'],
    [{ conditions: { playback: 'running' } }, 'conditions.playback'],
    [{ conditions: { power: 'unknown' } }, 'conditions.power'],
    [{ conditions: { keyboard: 'yes' } }, 'conditions.keyboard'],
    [{ conditions: { colour: 'red' } }, 'conditions.colour'],
    [{ conditions: { power: 'on' }, timeoutMs: 0 }, 'timeoutMs'],
    [{ conditions: { power: 'on' }, timeoutMs: 300001 }, 'timeoutMs'],
  ])('rejects %j', async (body, field) => {
    const { plugin } = await connectedPlugin();

    const response = await plugin.post(wait, body);

    expect(response.status).toBe(400);
    expect(response.body.error.details.field).toBe(field);
  });

  it('works on a device that is not connected', async () => {
    const { plugin, tv } = await connectedPlugin();
    tv.dropConnection();
    await delay(20);

    const response = await plugin.post(wait, { conditions: { power: 'on' }, timeoutMs: 500 });

    expect(response.status).toBe(200);
  });
});
