import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeApi, type FakeApi } from './support/fake-api.js';
import { createSandbox, type Sandbox } from './support/run-cli.js';
import { IDLE_PLAYING, TOKEN, livingRoomState } from './support/fixtures.js';

let api: FakeApi;
let sandbox: Sandbox;
const DEVICE = '/v1/devices/default';

beforeEach(async () => {
  api = await startFakeApi();
  sandbox = createSandbox({ AGENT_ATV_URL: api.url, AGENT_ATV_TOKEN: TOKEN });
  api.on('GET', `${DEVICE}/state`, { body: livingRoomState() });
  api.on('GET', `${DEVICE}/state?refresh=1`, { body: livingRoomState() });
});

afterEach(async () => {
  await api.close();
  sandbox.cleanup();
});

function posts(path: string): unknown[] {
  return api.requests.filter((request) => request.method === 'POST' && request.path === `${DEVICE}${path}`).map((request) => request.body);
}

describe('power', () => {
  beforeEach(() => {
    api.on('POST', `${DEVICE}/power`, (request) => {
      const power = (request.body as { on: boolean }).on ? 'on' : 'off';
      return { body: { ok: true, power, state: livingRoomState({ power }) } };
    });
  });

  it('prints the power state without an argument', async () => {
    const result = await sandbox.run(['power']);

    expect(result.stdout).toBe('power: on\n');
    expect(posts('/power')).toEqual([]);
  });

  it('sets power on or off', async () => {
    expect((await sandbox.run(['power', 'off'])).stdout).toBe('power: off\n');
    expect((await sandbox.run(['power', 'on'])).stdout).toBe('power: on\n');
    expect(posts('/power')).toEqual([{ on: false }, { on: true }]);
  });

  it('waits longer than the global HTTP timeout, since the plugin waits for the Apple TV to change state', async () => {
    api.on('POST', `${DEVICE}/power`, { body: { ok: true, power: 'off', state: livingRoomState({ power: 'off' }) }, delayMs: 400 });

    const result = await sandbox.run(['power', 'off', '--timeout', '100']);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('power: off\n');
  });

  it('toggles from the current state', async () => {
    const result = await sandbox.run(['power', 'toggle']);

    expect(result.stdout).toBe('power: off\n');
    expect(posts('/power')).toEqual([{ on: false }]);
  });

  it('rejects anything else with exit 2', async () => {
    expect((await sandbox.run(['power', 'maybe'])).code).toBe(2);
  });
});

describe('volume', () => {
  it('prints the volume without an argument', async () => {
    expect((await sandbox.run(['volume'])).stdout).toBe('volume: 35\n');
  });

  it('sets a level', async () => {
    api.on('POST', `${DEVICE}/volume`, { body: { ok: true, volume: 40, state: livingRoomState({ volume: 40 }) } });

    const result = await sandbox.run(['volume', '40']);

    expect(result.stdout).toBe('volume: 40\n');
    expect(posts('/volume')).toEqual([{ level: 40 }]);
  });

  it('steps up or down with the volume keys', async () => {
    api.on('POST', `${DEVICE}/keys`, { body: { ok: true, pressed: 3, state: livingRoomState({ volume: 50 }) } });

    const up = await sandbox.run(['volume', 'up', '--step', '3']);
    const down = await sandbox.run(['volume', 'down']);

    expect(up.stdout).toBe('volume: 50\n');
    expect(down.code).toBe(0);
    expect(posts('/keys')).toEqual([
      { keys: [{ key: 'volume_up', action: 'tap', count: 3 }], intervalMs: 200 },
      { keys: [{ key: 'volume_down', action: 'tap', count: 1 }], intervalMs: 200 },
    ]);
  });

  it.each(['101', '-1', 'loud'])('rejects %s with exit 2', async (value) => {
    expect((await sandbox.run(['volume', value])).code).toBe(2);
  });
});

describe('seek', () => {
  beforeEach(() => {
    api.on('POST', `${DEVICE}/seek`, { body: { ok: true, state: livingRoomState() } });
  });

  it.each([
    ['90', 90, '1:30'],
    ['12:33', 753, '12:33'],
    ['1:02:03', 3723, '1:02:03'],
    ['+30', 753, '12:33'],
    ['-10', 713, '11:53'],
    ['-1000', 0, '0:00'],
    ['+1:00', 783, '13:03'],
  ])('seek %s goes to %i seconds', async (target, position, printed) => {
    const result = await sandbox.run(['seek', target]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`position: ${printed}\n`);
    expect(posts('/seek')).toEqual([{ position }]);
  });

  it('reads a fresh position for relative seeks', async () => {
    await sandbox.run(['seek', '+30']);

    expect(api.requests[0]?.path).toBe(`${DEVICE}/state?refresh=1`);
  });

  it('fails a relative seek when nothing reports a position', async () => {
    api.on('GET', `${DEVICE}/state?refresh=1`, { body: livingRoomState({ playing: IDLE_PLAYING }) });

    const result = await sandbox.run(['seek', '+30']);

    expect(result.code).toBe(1);
    expect(posts('/seek')).toEqual([]);
  });

  it.each(['abc', '1:75', ''])('rejects "%s" with exit 2', async (target) => {
    expect((await sandbox.run(['seek', target])).code).toBe(2);
  });
});
