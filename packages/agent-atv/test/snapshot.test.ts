import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeApi, type FakeApi } from './support/fake-api.js';
import { createSandbox, type Sandbox } from './support/run-cli.js';
import { FOCUS_LINE, IDLE_PLAYING, NOT_PAIRED_FOCUS, NOT_PAIRED_LINE, SCREEN_OFF, TOKEN, focusReport, livingRoomState } from './support/fixtures.js';

let api: FakeApi;
let sandbox: Sandbox;

beforeEach(async () => {
  api = await startFakeApi();
  sandbox = createSandbox({ AGENT_ATV_URL: api.url, AGENT_ATV_TOKEN: TOKEN });
});

afterEach(async () => {
  await api.close();
  sandbox.cleanup();
});

describe('snapshot', () => {
  it('prints the refreshed state of the default device', async () => {
    api.on('GET', '/v1/devices/default/state?refresh=1&focus=1&app=1', { body: livingRoomState() });

    const result = await sandbox.run(['snapshot']);

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      [
        'Device: Living Room (A1B2C3D4E5F6) tvOS 27.2, connected',
        'Power: on',
        'App: Netflix (com.netflix.Netflix)',
        'Playing: playing video "Chapter One" (Stranger Things S4E1) 12:03/58:10 in Netflix',
        'Keyboard: unfocused',
        'Volume: 35',
        'Seq: 182',
        '',
      ].join('\n'),
    );
    expect(api.requests[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(api.requests[0]?.headers.accept).toBe('application/json');
  });

  it('shows idle playback, unknown app, focused keyboard text, missing volume and pending pairing', async () => {
    api.on('GET', '/v1/devices/default/state?refresh=1&focus=1&app=1', {
      body: livingRoomState({
        app: SCREEN_OFF,
        playing: IDLE_PLAYING,
        keyboard: { focus: 'focused', text: 'stran' },
        volume: null,
        needsPairing: true,
        connection: 'disconnected',
      }),
    });

    const result = await sandbox.run(['snapshot']);

    expect(result.code).toBe(0);
    const lines = result.stdout.trimEnd().split('\n');
    expect(lines).toContain('Device: Living Room (A1B2C3D4E5F6) tvOS 27.2, disconnected');
    expect(lines).toContain('App: unknown, screen reading off: enable "Screen reading" in the agent-atv plugin settings');
    expect(lines).toContain('Playing: idle');
    expect(lines).toContain('Keyboard: focused text="stran"');
    expect(lines).toContain('Volume: n/a');
    expect(lines).toContain('Pairing: required (run agent-atv pair)');
  });

  it.each([
    [{ available: true, kind: 'home' }, 'App: Home screen'],
    [{ available: true, kind: 'screensaver' }, 'App: Screensaver'],
    [
      {
        available: true,
        kind: 'ambiguous',
        apps: [
          { bundleId: 'com.apple.TVSettings', name: 'Settings' },
          { bundleId: 'com.netflix.Netflix', name: 'Netflix' },
        ],
      },
      'App: ambiguous, Settings (com.apple.TVSettings), Netflix (com.netflix.Netflix)',
    ],
  ])('names what tvOS shows: %j', async (app, line) => {
    api.on('GET', '/v1/devices/default/state?refresh=1&focus=1&app=1', { body: livingRoomState({ app }) });

    const result = await sandbox.run(['snapshot']);

    expect(result.stdout).toContain(`${line}\n`);
  });

  it('formats music with an artist, hour-long positions, and omits an unknown media type', async () => {
    api.on('GET', '/v1/devices/default/state?refresh=1&focus=1&app=1', {
      body: livingRoomState({
        playing: { ...IDLE_PLAYING, state: 'paused', mediaType: 'music', title: 'Song', artist: 'Band', position: 65, totalTime: 3725 },
      }),
    });
    const music = await sandbox.run(['snapshot']);
    expect(music.stdout).toContain('Playing: paused music "Song" - Band 1:05/1:02:05 in Netflix\n');

    api.on('GET', '/v1/devices/default/state?refresh=1&focus=1&app=1', {
      body: livingRoomState({ playing: { ...IDLE_PLAYING, state: 'loading', title: 'Trailer' } }),
    });
    const unknown = await sandbox.run(['snapshot']);
    expect(unknown.stdout).toContain('Playing: loading "Trailer" in Netflix\n');
  });

  it('addresses the device given with -d, URL-encoded', async () => {
    api.on('GET', '/v1/devices/Living%20Room/state?refresh=1&focus=1&app=1', { body: livingRoomState() });

    const result = await sandbox.run(['snapshot', '-d', 'Living Room']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Device: Living Room');
  });

  it('prints the API body on one line with --json', async () => {
    const state = livingRoomState();
    api.on('GET', '/v1/devices/default/state?refresh=1&focus=1&app=1', { body: state });

    const result = await sandbox.run(['--json', 'snapshot']);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${JSON.stringify(state)}\n`);
  });

  it('prints the focused element after the keyboard line', async () => {
    api.on('GET', '/v1/devices/default/state?refresh=1&focus=1&app=1', { body: { ...livingRoomState(), focus: focusReport() } });

    const lines = (await sandbox.run(['snapshot'])).stdout.trimEnd().split('\n');

    expect(lines.slice(4, 6)).toEqual(['Keyboard: unfocused', FOCUS_LINE]);
  });

  it.each([
    [{ label: 'Volume', value: '35%', identifier: 'volume-slider' }, 'Focus: "Volume" (id volume-slider, value 35%)'],
    [{ label: null, value: null, identifier: 'artwork/42' }, 'Focus: (id artwork/42)'],
    [{ label: 'Play', value: null, identifier: null }, 'Focus: "Play"'],
    // An older plugin sends these for an element it could not read.
    [null, 'Focus: unknown'],
    [{ label: null, value: null, identifier: null }, 'Focus: unknown'],
  ])('formats the focused element %j', async (element, line) => {
    api.on('GET', '/v1/devices/default/state?refresh=1&focus=1&app=1', { body: { ...livingRoomState(), focus: focusReport(element) } });

    expect((await sandbox.run(['snapshot'])).stdout).toContain(`${line}\n`);
  });

  it('says what to do when screen reading is not paired, and still exits 0', async () => {
    api.on('GET', '/v1/devices/default/state?refresh=1&focus=1&app=1', { body: { ...livingRoomState(), focus: NOT_PAIRED_FOCUS } });

    const result = await sandbox.run(['snapshot']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`${NOT_PAIRED_LINE}\n`);
  });

  it('skips the focus with --no-focus', async () => {
    api.on('GET', '/v1/devices/default/state?refresh=1&app=1', { body: livingRoomState() });

    const result = await sandbox.run(['snapshot', '--no-focus']);

    expect(result.code).toBe(0);
    expect(api.requests[0]?.path).toBe('/v1/devices/default/state?refresh=1&app=1');
    expect(result.stdout).not.toContain('Focus:');
  });
});
