import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeApi, type FakeApi } from './support/fake-api.js';
import { createSandbox, type Sandbox } from './support/run-cli.js';
import { FOCUS_LINE, NOT_PAIRED_FOCUS, NOT_PAIRED_LINE, TOKEN, focusReport, livingRoomState } from './support/fixtures.js';

let api: FakeApi;
let sandbox: Sandbox;
const DEVICE = '/v1/devices/default';
const NETFLIX = { bundleId: 'com.netflix.Netflix', name: 'Netflix' };

const ACTIONS: [string[], string, string, Record<string, unknown>][] = [
  [['press', 'right'], 'pressed right', '/keys', { pressed: 1 }],
  [['back'], 'pressed menu', '/keys', { pressed: 1 }],
  [['home'], 'pressed home', '/keys', { pressed: 1 }],
  [['open', 'Netflix'], 'opened Netflix (com.netflix.Netflix)', '/open', { app: NETFLIX, foreground: true }],
  [['type', 'x'], 'keyboard: "x"', '/keyboard', { keyboard: { focus: 'focused', text: 'x' } }],
  [['fill', 'x'], 'keyboard: "x"', '/keyboard', { keyboard: { focus: 'focused', text: 'x' } }],
  [['clear'], 'keyboard: "x"', '/keyboard', { keyboard: { focus: 'focused', text: 'x' } }],
];

function reply(route: string, fields: Record<string, unknown>, focus: unknown): void {
  api.on('POST', `${DEVICE}${route}`, { body: { ok: true, ...fields, ...(focus ? { focus } : {}), state: livingRoomState() } });
}

beforeEach(async () => {
  api = await startFakeApi();
  sandbox = createSandbox({ AGENT_ATV_URL: api.url, AGENT_ATV_TOKEN: TOKEN });
});

afterEach(async () => {
  await api.close();
  sandbox.cleanup();
});

describe('actions are silent by default', () => {
  it.each(ACTIONS)('%j prints only its own line and asks for no focus', async (args, line, route, fields) => {
    // A plugin from before --settle still sends a focus report; a plain action does not print it.
    reply(route, fields, focusReport());

    const result = await sandbox.run(args);

    expect([result.code, result.stdout, result.stderr]).toEqual([0, `${line}\n`, '']);
    expect(api.requests[0]?.body).not.toHaveProperty('focus');
  });

  it('no longer takes --no-focus on an action', async () => {
    const result = await sandbox.run(['press', 'up', '--no-focus']);

    expect(result.code).toBe(2);
    expect(api.requests).toHaveLength(0);
  });
});

describe('--settle', () => {
  it.each(ACTIONS)('%j asks the plugin for the settled focus and prints it', async (args, line, route, fields) => {
    reply(route, fields, focusReport());

    const result = await sandbox.run([...args, '--settle']);

    expect([result.code, result.stdout]).toEqual([0, `${line}\n${FOCUS_LINE}\n`]);
    expect(api.requests[0]?.body).toMatchObject({ focus: true });
  });

  it.each([
    [NOT_PAIRED_FOCUS, NOT_PAIRED_LINE],
    [
      {
        available: false,
        code: 'FOCUS_UNKNOWN',
        reason: 'focus not known',
        hint: 'move the focus with a direction key (agent-atv press down --settle), or look with agent-atv screenshot',
      },
      'Focus: unavailable, focus not known: move the focus with a direction key (agent-atv press down --settle), or look with agent-atv screenshot',
    ],
    [
      {
        available: false,
        code: 'SCREEN_NOT_CONFIGURED',
        reason: 'screen reading off',
        hint: 'enable "Screen reading" in the agent-atv plugin settings',
      },
      'Focus: unavailable, screen reading off: enable "Screen reading" in the agent-atv plugin settings',
    ],
  ])('prints what to do when the focus is unavailable (%j), and exits 0', async (report, focusLine) => {
    reply('/keys', { pressed: 1 }, report);

    const result = await sandbox.run(['press', 'select', '--settle']);

    expect([result.code, result.stdout]).toEqual([0, `pressed select\n${focusLine}\n`]);
  });

  it('says so when the key moved nothing', async () => {
    reply('/keys', { pressed: 1 }, { ...focusReport(), moved: false });

    const result = await sandbox.run(['press', 'left', '--settle']);

    expect(result.stdout).toBe(`pressed left\n${FOCUS_LINE}, no move reported\n`);
  });

  it('carries the focus report in --json', async () => {
    reply('/keys', { pressed: 1 }, NOT_PAIRED_FOCUS);

    const result = await sandbox.run(['press', 'up', '--settle', '--json']);

    expect(JSON.parse(result.stdout)).toEqual({ ok: true, pressed: 1, focus: NOT_PAIRED_FOCUS, state: livingRoomState() });
  });
});
