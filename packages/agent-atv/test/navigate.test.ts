import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeApi, type FakeApi } from './support/fake-api.js';
import { createSandbox, type Sandbox } from './support/run-cli.js';
import { NOT_PAIRED_FOCUS, TOKEN, apiError, livingRoomState } from './support/fixtures.js';

let api: FakeApi;
let sandbox: Sandbox;
const DEVICE = '/v1/devices/default';

const tile = (label: string, value: string | null = null) => ({ label, value, identifier: 'AppCell' });
const NETFLIX = tile('Netflix');
const YOUTUBE = tile('YouTube');
const DISNEY = tile('Disney+', 'Recently Updated');
const PLEX = tile('Plex');

const moved = (element: unknown) => ({ available: true, element, moved: true });
const stayed = (element: unknown) => ({ available: true, element, moved: false });

/** The settled focus of each press, in order; the last one repeats. */
function presses(...reports: unknown[]): void {
  api.on('POST', `${DEVICE}/keys`, ...reports.map((focus) => ({ body: { ok: true, pressed: 1, focus, state: livingRoomState() } })));
}

function startingAt(element: unknown): void {
  api.on('GET', `${DEVICE}/focus`, { body: { focus: element, durationMs: 80 } });
}

const keyRequests = () => api.requests.filter((request) => request.path === `${DEVICE}/keys`);

beforeEach(async () => {
  api = await startFakeApi();
  sandbox = createSandbox({ AGENT_ATV_URL: api.url, AGENT_ATV_TOKEN: TOKEN });
  api.on('GET', `${DEVICE}/focus`, {
    status: 409,
    body: apiError('FOCUS_UNKNOWN', 'The focus is not known', 'move the focus with a direction key (agent-atv press down --settle)'),
  });
});

afterEach(async () => {
  await api.close();
  sandbox.cleanup();
});

describe('press <arrow> --until <text>', () => {
  it('presses one key at a time with the settled focus until the focused element matches', async () => {
    presses(moved(YOUTUBE), moved(DISNEY), moved(PLEX));

    const result = await sandbox.run(['press', 'right', '--until', 'plex']);

    expect([result.code, result.stdout]).toEqual([0, 'pressed right*3 until "plex"\nFocus: "Plex" (id AppCell)\n']);
    expect(keyRequests().map((request) => request.body)).toEqual(
      Array.from({ length: 3 }, () => ({ keys: [{ key: 'right', action: 'tap', count: 1 }], intervalMs: 200, focus: true })),
    );
  });

  it('matches the label, value or identifier, ignoring case and accents', async () => {
    presses(moved(tile('Saison 1')), moved(tile('Épisode 3, Le départ')));

    const result = await sandbox.run(['press', 'down', '--until', 'EPISODE 3']);

    expect(result.code).toBe(0);
    expect(keyRequests()).toHaveLength(2);
  });

  it('presses nothing when the focused element already matches', async () => {
    startingAt(PLEX);

    const result = await sandbox.run(['press', 'right', '--until', 'Plex']);

    expect([result.code, result.stdout]).toEqual([0, 'pressed nothing: the focus already matches "Plex"\nFocus: "Plex" (id AppCell)\n']);
    expect(keyRequests()).toHaveLength(0);
  });

  it('stops when a press reports no move, listing what it passed, and says where else to look', async () => {
    startingAt(NETFLIX);
    presses(moved(YOUTUBE), moved(PLEX), stayed(PLEX));

    const result = await sandbox.run(['press', 'right', '--until', 'Arte']);

    expect(result.code).toBe(5);
    expect(result.stdout).toBe(
      ['pressed right*3: "Arte" not found', '0 "Netflix" (id AppCell)', '1 "YouTube" (id AppCell)', '2 "Plex" (id AppCell)  <- focus', ''].join('\n'),
    );
    expect(result.stderr).toContain('no move reported after press 3');
    expect(result.stderr).toContain('agent-atv press left --until "Arte"');
  });

  it('stops when the focus comes back to an element it passed: the row wraps around', async () => {
    presses(moved(YOUTUBE), moved(PLEX), moved(NETFLIX), moved(YOUTUBE));

    const result = await sandbox.run(['press', 'right', '--until', 'Arte']);

    expect(result.code).toBe(5);
    expect(keyRequests()).toHaveLength(4);
    expect(result.stderr).toContain('came back to "YouTube"');
  });

  it('stops after --max presses and says how to go on', async () => {
    let n = 0;
    api.on('POST', `${DEVICE}/keys`, () => ({ body: { ok: true, pressed: 1, focus: moved(tile(`Tile ${(n += 1)}`)), state: livingRoomState() } }));

    const result = await sandbox.run(['press', 'down', '--until', 'Arte', '--max', '4']);

    expect(result.code).toBe(5);
    expect(keyRequests()).toHaveLength(4);
    expect(result.stderr).toContain('agent-atv press down --until "Arte" --max 8');
  });

  it('stops at the first press whose focus is unavailable, with its fix', async () => {
    presses(NOT_PAIRED_FOCUS);

    const result = await sandbox.run(['press', 'right', '--until', 'Plex']);

    expect(result.code).toBe(8);
    expect(keyRequests()).toHaveLength(1);
    expect(result.stderr).toContain('run agent-atv pair A1B2C3D4E5F6 --screen');
  });

  it('carries the presses and the elements passed in --json', async () => {
    presses(moved(YOUTUBE), moved(PLEX));

    const result = await sandbox.run(['press', 'right', '--until', 'plex', '--json']);

    expect(JSON.parse(result.stdout)).toEqual({ found: true, presses: 2, start: null, passed: [YOUTUBE, PLEX], focus: PLEX });
  });

  it.each([
    [['press', 'select', '--until', 'Plex']],
    [['press', 'right', 'down', '--until', 'Plex']],
    [['press', 'right*2', '--until', 'Plex']],
    [['press', 'right', '--until', 'Plex', '--hold']],
    [['press', 'right', '--until', 'Plex', '--scan']],
    [['press', 'right', '--until', 'Plex', '--max', '0']],
  ])('rejects %j with exit 2 before pressing anything', async (args) => {
    const result = await sandbox.run(args);

    expect(result.code).toBe(2);
    expect(keyRequests()).toHaveLength(0);
  });
});

describe('press <arrow> --scan', () => {
  it('presses until no move is reported and lists every element, numbered from the start', async () => {
    startingAt(NETFLIX);
    presses(moved(YOUTUBE), moved(DISNEY), moved(PLEX), stayed(PLEX));

    const result = await sandbox.run(['press', 'right', '--scan']);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      [
        'scanned right: 3 moves, then no move reported (the end of the row, or a screen that does not report moves)',
        '0 "Netflix" (id AppCell)',
        '1 "YouTube" (id AppCell)',
        '2 "Disney+" (id AppCell, value Recently Updated)',
        '3 "Plex" (id AppCell)  <- focus',
        '',
      ].join('\n'),
    );
  });

  it('carries the stop and the elements in --json', async () => {
    presses(moved(YOUTUBE), stayed(YOUTUBE));

    const result = await sandbox.run(['press', 'left', '--scan', '--json']);

    expect(JSON.parse(result.stdout)).toEqual({ stop: 'no_move', presses: 2, start: null, passed: [YOUTUBE], focus: YOUTUBE });
  });

  it('stops at the first press whose focus is unavailable, with its fix', async () => {
    presses(NOT_PAIRED_FOCUS);

    const result = await sandbox.run(['press', 'left', '--scan']);

    expect(result.code).toBe(8);
    expect(keyRequests()).toHaveLength(1);
  });
});
