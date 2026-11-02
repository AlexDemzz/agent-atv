import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeApi, type FakeApi } from './support/fake-api.js';
import { createSandbox, type Sandbox } from './support/run-cli.js';
import { FOCUS, FOCUS_LINE, IDLE_PLAYING, TOKEN, apiError, livingRoomState } from './support/fixtures.js';

let api: FakeApi;
let sandbox: Sandbox;
const WAIT = '/v1/devices/default/wait';

beforeEach(async () => {
  api = await startFakeApi();
  sandbox = createSandbox({ AGENT_ATV_URL: api.url, AGENT_ATV_TOKEN: TOKEN });
});

afterEach(async () => {
  await api.close();
  sandbox.cleanup();
});

function matchedReply(matched: string[], elapsedMs: number, delayMs = 0) {
  return { body: { ok: true, matched, elapsedMs, state: livingRoomState() }, delayMs };
}

describe('wait for conditions', () => {
  it('sends the conditions with the default 25000ms timeout and reports what matched', async () => {
    api.on('POST', WAIT, matchedReply(['app', 'idleMs'], 2340));

    const result = await sandbox.run(['wait', '--app', 'com.netflix.Netflix', '--idle', '1000']);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('ok app idle (2340ms)\n');
    expect(api.requests[0]?.body).toEqual({
      conditions: { app: 'com.netflix.Netflix', idleMs: 1000 },
      timeoutMs: 25000,
    });
  });

  it.each([
    [['--playing'], { playback: 'playing' }],
    [['--paused'], { playback: 'paused' }],
    [['--playback', 'seeking'], { playback: 'seeking' }],
    [['--power', 'off'], { power: 'off' }],
    [['--keyboard'], { keyboard: 'focused' }],
    [['--no-keyboard'], { keyboard: 'unfocused' }],
    [['--text', 'stranger'], { text: 'stranger' }],
    [['--power', 'on', '--keyboard', '--text', 'x'], { power: 'on', keyboard: 'focused', text: 'x' }],
  ])('maps %j to conditions %j', async (flags, conditions) => {
    api.on('POST', WAIT, matchedReply(Object.keys(conditions), 10));

    const result = await sandbox.run(['wait', ...flags]);

    expect(result.code).toBe(0);
    expect((api.requests[0]?.body as { conditions: unknown }).conditions).toEqual(conditions);
  });

  it('sizes the HTTP timeout from its own --timeout, ignoring AGENT_ATV_TIMEOUT_MS', async () => {
    api.on('POST', WAIT, matchedReply(['playback'], 600, 600));

    const result = await sandbox.run(['wait', '--playing', '--timeout', '1000'], { env: { AGENT_ATV_TIMEOUT_MS: '200' } });

    expect(result.code).toBe(0);
    expect((api.requests[0]?.body as { timeoutMs: number }).timeoutMs).toBe(1000);
  });

  it('exits 7 on WAIT_TIMEOUT with a hint built from the current state', async () => {
    api.on('POST', WAIT, {
      status: 408,
      body: apiError('WAIT_TIMEOUT', 'Timed out after 5000ms waiting for playback=playing', 'Run agent-atv snapshot', {
        elapsedMs: 5000,
        pending: ['playback'],
        state: livingRoomState({ playing: { ...IDLE_PLAYING, state: 'paused', mediaType: 'video', title: 'Chapter One' } }),
      }),
    });

    const result = await sandbox.run(['wait', '--playing', '--timeout', '5000']);

    expect(result.code).toBe(7);
    expect(result.stderr).toBe(
      'error: Timed out after 5000ms waiting for playback=playing (WAIT_TIMEOUT)\n' +
        'hint: Current state: paused video "Chapter One" in Netflix. Run agent-atv snapshot to see where you are.\n',
    );
  });

  it.each([
    [['wait']],
    [['wait', '500', '--playing']],
    [['wait', '--playing', '--paused']],
    [['wait', '--playback', 'dancing']],
    [['wait', '--power', 'maybe']],
    [['wait', '--playing', '--timeout', '0']],
  ])('rejects %j with exit 2', async (args) => {
    const result = await sandbox.run(args);

    expect(result.code).toBe(2);
    expect(api.requests).toHaveLength(0);
  });
});

describe('wait --app', () => {
  it('names the home screen in the timeout hint as --app accepts it', async () => {
    api.on('POST', WAIT, {
      status: 408,
      body: apiError('WAIT_TIMEOUT', 'Timed out after 500ms waiting for app=netflix', 'Run agent-atv snapshot', {
        elapsedMs: 500,
        pending: ['app'],
        app: { kind: 'home' },
        state: livingRoomState(),
      }),
    });

    const result = await sandbox.run(['wait', '--app', 'netflix', '--timeout', '500']);

    expect(result.code).toBe(7);
    expect(result.stderr).toContain('hint: Current state: app home. Run agent-atv snapshot to see where you are.\n');
  });
});

describe('wait --focus', () => {
  it('waits for a focused element containing the text and prints it', async () => {
    api.on('POST', WAIT, { body: { ok: true, matched: ['focus'], elapsedMs: 750, focus: FOCUS, state: livingRoomState() } });

    const result = await sandbox.run(['wait', '--focus', 'swipe up']);

    expect([result.code, result.stdout]).toEqual([0, `ok focus (750ms)\n${FOCUS_LINE}\n`]);
    expect((api.requests[0]?.body as { conditions: unknown }).conditions).toEqual({ focus: 'swipe up' });
  });

  it('shows the last focused element in the timeout hint', async () => {
    api.on('POST', WAIT, {
      status: 408,
      body: apiError('WAIT_TIMEOUT', 'Timed out after 500ms waiting for focus=netflix', 'Run agent-atv snapshot', {
        elapsedMs: 500,
        pending: ['focus'],
        focus: FOCUS,
        state: livingRoomState(),
      }),
    });

    const result = await sandbox.run(['wait', '--focus', 'netflix', '--timeout', '500']);

    expect(result.code).toBe(7);
    expect(result.stderr).toContain(
      'hint: Current state: focus "Swipe up for full screen" (id top-shelf/swipe-up-affordance/arrow). Run agent-atv snapshot to see where you are.\n',
    );
  });

  it('says the focus is unknown in the timeout hint when the plugin never knew it', async () => {
    api.on('POST', WAIT, {
      status: 408,
      body: apiError('WAIT_TIMEOUT', 'Timed out after 500ms waiting for focus=netflix', 'Run agent-atv snapshot', {
        elapsedMs: 500,
        pending: ['focus'],
        focus: null,
        state: livingRoomState(),
      }),
    });

    const result = await sandbox.run(['wait', '--focus', 'netflix', '--timeout', '500']);

    expect(result.stderr).toContain('hint: Current state: focus unknown. Run agent-atv snapshot to see where you are.\n');
  });

  it('exits 8 with the hint when screen reading is not paired', async () => {
    api.on('POST', WAIT, {
      status: 503,
      body: apiError('SCREEN_NOT_PAIRED', 'Screen reading is not paired on Living Room', 'run agent-atv pair A1B2C3D4E5F6 --screen'),
    });

    const result = await sandbox.run(['wait', '--focus', 'netflix']);

    expect(result.code).toBe(8);
    expect(result.stderr).toContain('hint: run agent-atv pair A1B2C3D4E5F6 --screen\n');
  });
});

describe('wait <ms>', () => {
  it('sleeps client-side without calling the API', async () => {
    const started = Date.now();

    const result = await sandbox.run(['wait', '300'], { env: { AGENT_ATV_URL: undefined } });

    expect(result.code).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(result.stdout).toBe('ok waited 300ms\n');
    expect(api.requests).toHaveLength(0);
  });
});
