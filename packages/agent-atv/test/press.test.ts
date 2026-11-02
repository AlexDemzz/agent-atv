import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeApi, type FakeApi } from './support/fake-api.js';
import { createSandbox, type Sandbox } from './support/run-cli.js';
import { TOKEN, livingRoomState } from './support/fixtures.js';

let api: FakeApi;
let sandbox: Sandbox;
const KEYS = '/v1/devices/default/keys';

beforeEach(async () => {
  api = await startFakeApi();
  sandbox = createSandbox({ AGENT_ATV_URL: api.url, AGENT_ATV_TOKEN: TOKEN });
  api.on('POST', KEYS, (request) => {
    const keys = (request.body as { keys: { count: number }[] }).keys;
    return { body: { ok: true, pressed: keys.reduce((sum, key) => sum + key.count, 0), state: livingRoomState() } };
  });
});

afterEach(async () => {
  await api.close();
  sandbox.cleanup();
});

describe('press', () => {
  it('sends the key sequence with counts and the default interval', async () => {
    const result = await sandbox.run(['press', 'down*2', 'right', 'select']);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('pressed down*2 right select\n');
    expect(api.requests[0]?.headers['content-type']).toBe('application/json');
    expect(api.requests[0]?.body).toEqual({
      keys: [
        { key: 'down', action: 'tap', count: 2 },
        { key: 'right', action: 'tap', count: 1 },
        { key: 'select', action: 'tap', count: 1 },
      ],
      intervalMs: 200,
    });
  });

  it('resolves aliases case-insensitively and turns dashes into underscores', async () => {
    const result = await sandbox.run(['press', 'Enter', 'back', 'ArrowUp', 'play-pause', 'ff', 'rw', 'tv', 'VolUp', 'space', 'esc']);

    expect(result.stdout).toBe(
      'pressed select menu up play_pause skip_forward skip_backward home volume_up play_pause menu\n',
    );
  });

  it('applies actions from the spec, and --hold or --double to specs without one', async () => {
    const own = await sandbox.run(['press', 'select:hold', 'home:double', '--interval', '50']);
    expect(own.stdout).toBe('pressed select:hold home:double\n');
    expect(api.requests[0]?.body).toEqual({
      keys: [
        { key: 'select', action: 'hold', count: 1 },
        { key: 'home', action: 'double', count: 1 },
      ],
      intervalMs: 50,
    });

    const global = await sandbox.run(['press', 'up:tap', 'select', '--hold']);
    expect(global.stdout).toBe('pressed up select:hold\n');
  });

  it('rejects an unknown key with exit 2, listing valid keys, without calling the API', async () => {
    const result = await sandbox.run(['press', 'up', 'jump']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('jump');
    expect(result.stderr).toContain('play_pause');
    expect(api.requests).toHaveLength(0);
  });

  it.each(['up*0', 'up*51', 'up*x', 'play:hold', 'up:smash'])('rejects the spec %s with exit 2', async (spec) => {
    const result = await sandbox.run(['press', spec]);

    expect(result.code).toBe(2);
    expect(api.requests).toHaveLength(0);
  });

  it('needs at least one key', async () => {
    expect((await sandbox.run(['press'])).code).toBe(2);
  });

  it('prints the API response with --json', async () => {
    const result = await sandbox.run(['press', 'up', '--json']);

    expect(JSON.parse(result.stdout)).toEqual({ ok: true, pressed: 1, state: livingRoomState() });
  });
});

describe('back and home', () => {
  it('press menu and home', async () => {
    const back = await sandbox.run(['back']);
    const home = await sandbox.run(['home']);

    expect(back.stdout).toBe('pressed menu\n');
    expect(home.stdout).toBe('pressed home\n');
    expect(api.requests.map((request) => (request.body as { keys: unknown[] }).keys)).toEqual([
      [{ key: 'menu', action: 'tap', count: 1 }],
      [{ key: 'home', action: 'tap', count: 1 }],
    ]);
  });
});
