import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeApi, type FakeApi } from './support/fake-api.js';
import { createSandbox, type Sandbox } from './support/run-cli.js';
import { FOCUS, NETFLIX_REPORT, SCREEN_OFF, TOKEN, apiError, livingRoomState } from './support/fixtures.js';

let api: FakeApi;
let sandbox: Sandbox;
const CACHED = '/v1/devices/default/state';

beforeEach(async () => {
  api = await startFakeApi();
  sandbox = createSandbox({ AGENT_ATV_URL: api.url, AGENT_ATV_TOKEN: TOKEN });
});

afterEach(async () => {
  await api.close();
  sandbox.cleanup();
});

describe('state <field>', () => {
  it.each([
    ['power', 'on'],
    ['playing', 'playing video "Chapter One" (Stranger Things S4E1) 12:03/58:10 in Netflix'],
    ['keyboard', 'unfocused'],
    ['volume', '35'],
    ['connection', 'connected'],
    ['seq', '182'],
  ])('prints %s from the cached state', async (field, expected) => {
    api.on('GET', CACHED, { body: livingRoomState() });

    const result = await sandbox.run(['state', field]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${expected}\n`);
    expect(api.requests[0]?.path).toBe(CACHED);
  });

  it('prints focused keyboard text and missing volume', async () => {
    api.on('GET', CACHED, {
      body: livingRoomState({ keyboard: { focus: 'focused', text: 'stran' }, volume: null }),
    });

    expect((await sandbox.run(['state', 'keyboard'])).stdout).toBe('focused "stran"\n');
    expect((await sandbox.run(['state', 'volume'])).stdout).toBe('n/a\n');
  });

  it('prints {"<field>": value} with --json', async () => {
    api.on('GET', CACHED, { body: livingRoomState() });

    const result = await sandbox.run(['state', 'power', '--json']);

    expect(JSON.parse(result.stdout)).toEqual({ power: 'on' });
  });

  it('prints the snapshot layout without a field, from the cache: no App or Focus line', async () => {
    const { app: _app, ...cached } = livingRoomState();
    api.on('GET', CACHED, { body: cached });

    const result = await sandbox.run(['state']);

    expect(result.stdout).toContain('Device: Living Room (A1B2C3D4E5F6) tvOS 27.2, connected\nPower: on\nPlaying:');
  });

  it('rejects an unknown field with exit 2, listing the fields', async () => {
    const result = await sandbox.run(['state', 'colour']);
    expect(result.code).toBe(2);
    expect(result.stderr).toBe(
      'error: Unknown state field "colour" (USAGE)\nhint: use one of: power, app, playing, keyboard, volume, connection, seq, focus\n',
    );
  });

  it('says how to call it with too many fields', async () => {
    const result = await sandbox.run(['state', 'app', 'power']);
    expect([result.code, result.stderr]).toEqual([2, 'error: state takes at most one field (USAGE)\nhint: e.g. agent-atv state focus\n']);
  });

  it.each([
    [NETFLIX_REPORT, 'com.netflix.Netflix Netflix'],
    [{ available: true, kind: 'home' }, 'home screen'],
    [{ available: true, kind: 'screensaver' }, 'screensaver'],
    [
      { available: true, kind: 'ambiguous', apps: [{ bundleId: 'com.apple.TVSettings', name: 'Settings' }, NETFLIX_REPORT] },
      'ambiguous: com.apple.TVSettings Settings, com.netflix.Netflix Netflix',
    ],
  ])('reads the foreground app with state app: %j', async (app, expected) => {
    api.on('GET', `${CACHED}?app=1`, { body: livingRoomState({ app }) });

    const text = await sandbox.run(['state', 'app']);
    const json = await sandbox.run(['state', 'app', '--json']);

    expect([text.code, text.stdout]).toEqual([0, `${expected}\n`]);
    expect(JSON.parse(json.stdout)).toEqual({ app });
  });

  it('exits 8 with the fix when screen reading cannot tell the foreground app', async () => {
    api.on('GET', `${CACHED}?app=1`, { body: livingRoomState({ app: SCREEN_OFF }) });

    const result = await sandbox.run(['state', 'app']);

    expect(result.code).toBe(8);
    expect(result.stderr).toBe(
      'error: The foreground app is not known: screen reading off (SCREEN_NOT_CONFIGURED)\n' +
        'hint: enable "Screen reading" in the agent-atv plugin settings\n',
    );
  });

  it('reads the focused element with state focus', async () => {
    api.on('GET', '/v1/devices/default/focus', { body: { focus: FOCUS, durationMs: 210 } });

    const text = await sandbox.run(['state', 'focus']);
    const json = await sandbox.run(['state', 'focus', '--json']);

    expect([text.code, text.stdout]).toEqual([0, '"Swipe up for full screen" (id top-shelf/swipe-up-affordance/arrow)\n']);
    expect(JSON.parse(json.stdout)).toEqual({ focus: FOCUS });
  });

  it('exits 8 with the hint when screen reading is not paired', async () => {
    api.on('GET', '/v1/devices/default/focus', {
      status: 503,
      body: apiError('SCREEN_NOT_PAIRED', 'Screen reading is not paired on Living Room', 'run agent-atv pair A1B2C3D4E5F6 --screen'),
    });

    const result = await sandbox.run(['state', 'focus']);

    expect(result.code).toBe(8);
    expect(result.stderr).toBe(
      'error: Screen reading is not paired on Living Room (SCREEN_NOT_PAIRED)\nhint: run agent-atv pair A1B2C3D4E5F6 --screen\n',
    );
  });
});
