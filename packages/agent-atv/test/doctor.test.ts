import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeApi, type FakeApi } from './support/fake-api.js';
import { createSandbox, type Sandbox } from './support/run-cli.js';
import { TOKEN, apiError, livingRoomState } from './support/fixtures.js';

let api: FakeApi;
let sandbox: Sandbox;

const INFO = {
  version: '0.1.0',
  bridge: { status: 'ready', backend: 'pyatv', python: '3.11.2', pyatv: '0.18.0', error: null },
  screen: { enabled: false, status: 'disabled', ready: false, reason: 'screen.enabled is off', pymobiledevice3: null },
  devices: 1,
};
const SUMMARY = {
  id: 'A1B2C3D4E5F6',
  name: 'Living Room',
  address: '192.168.1.50',
  model: 'Apple TV 4K (gen 3)',
  version: '27.2',
  paired: true,
  needsPairing: false,
  connection: 'connected',
  protocols: { companion: true, airplay: true },
  screen: 'off',
};

beforeEach(async () => {
  api = await startFakeApi();
  sandbox = createSandbox({ AGENT_ATV_URL: api.url, AGENT_ATV_TOKEN: TOKEN });
  api.on('GET', '/v1/health', { body: { ok: true, name: 'homebridge-agent-atv', version: '0.1.0' } });
  api.on('GET', '/v1/info', { body: INFO });
  api.on('GET', '/v1/devices', { body: { devices: [SUMMARY] } });
  api.on('GET', '/v1/devices/default/state', { body: livingRoomState() });
});

afterEach(async () => {
  await api.close();
  sandbox.cleanup();
});

function statuses(stdout: string): string[] {
  return stdout
    .trimEnd()
    .split('\n')
    .map((line) => line.split(':')[0] as string);
}

describe('doctor', () => {
  it('runs every check in order and exits 0 when only the screen check warns', async () => {
    const result = await sandbox.run(['doctor']);

    expect(result.code).toBe(0);
    expect(statuses(result.stdout)).toEqual([
      'ok config',
      'ok health',
      'ok token',
      'ok bridge',
      'ok paired',
      'ok device',
      'warn screen',
    ]);
    expect(result.stdout).toContain('warn screen: off; hint: optional: enable "Screen reading" in the agent-atv plugin settings');
    expect(result.stdout).not.toContain(TOKEN);
    const health = api.requests.find((request) => request.path === '/v1/health');
    expect(health?.headers.authorization).toBeUndefined();
  });

  it('fails the config check without a url and stops', async () => {
    const result = await sandbox.run(['doctor'], { env: { AGENT_ATV_URL: undefined } });

    expect(result.code).toBe(1);
    expect(statuses(result.stdout)).toEqual(['fail config']);
    expect(api.requests).toHaveLength(0);
  });

  it('fails the token check on 401 and stops there', async () => {
    api.on('GET', '/v1/info', { status: 401, body: apiError('UNAUTHORIZED', 'Invalid token', 'Check the token') });

    const result = await sandbox.run(['doctor']);

    expect(result.code).toBe(1);
    expect(statuses(result.stdout)).toEqual(['ok config', 'ok health', 'fail token']);
  });

  it('fails when the bridge is not ready, nothing is paired, or the default device is down', async () => {
    api.on('GET', '/v1/info', { body: { ...INFO, bridge: { ...INFO.bridge, status: 'error', error: 'Python 3.9 is too old' } } });
    api.on('GET', '/v1/devices', { body: { devices: [{ ...SUMMARY, paired: false, connection: 'unpaired' }] } });
    api.on('GET', '/v1/devices/default/state', {
      status: 409,
      body: apiError('NOT_PAIRED', 'No paired device', 'Run agent-atv pair'),
    });

    const result = await sandbox.run(['doctor']);

    expect(result.code).toBe(1);
    expect(statuses(result.stdout)).toEqual([
      'ok config',
      'ok health',
      'ok token',
      'fail bridge',
      'fail paired',
      'fail device',
      'warn screen',
    ]);
    expect(result.stdout).toContain('Python 3.9 is too old');
  });

  it('reports checks as JSON', async () => {
    api.on('GET', '/v1/info', { body: { ...INFO, screen: { enabled: true, status: 'ready', ready: true, reason: null, pymobiledevice3: '11.49.1' } } });
    api.on('GET', '/v1/devices', { body: { devices: [{ ...SUMMARY, screen: 'connected' }] } });

    const result = await sandbox.run(['doctor', '--json']);

    const body = JSON.parse(result.stdout) as { ok: boolean; checks: { name: string; status: string; detail: string; hint: string }[] };
    expect(body.ok).toBe(true);
    expect(body.checks.map((check) => [check.name, check.status])).toEqual([
      ['config', 'ok'],
      ['health', 'ok'],
      ['token', 'ok'],
      ['bridge', 'ok'],
      ['paired', 'ok'],
      ['device', 'ok'],
      ['screen', 'ok'],
    ]);
    for (const check of body.checks) {
      expect(typeof check.detail).toBe('string');
      expect(typeof check.hint).toBe('string');
    }
  });

  it.each([
    [{ status: 'installing', reason: 'installing pymobiledevice3 (about 2 minutes on first start)' }, 'off', 'wait a few minutes, then run agent-atv doctor again'],
    [{ status: 'error', reason: 'pip failed' }, 'off', 'ask the user to fix the error in the Homebridge log, then restart Homebridge'],
    [{ status: 'ready', reason: null }, 'unpaired', 'run agent-atv pair A1B2C3D4E5F6 --screen'],
    [{ status: 'ready', reason: null }, 'disconnected', 'wake the Apple TV with agent-atv power on, then run agent-atv doctor again'],
  ])('warns about screen reading %j with what to do', async (screen, deviceScreen, hint) => {
    api.on('GET', '/v1/info', { body: { ...INFO, screen: { enabled: true, ready: false, pymobiledevice3: null, ...screen } } });
    api.on('GET', '/v1/devices', { body: { devices: [{ ...SUMMARY, screen: deviceScreen }] } });

    const result = await sandbox.run(['doctor']);

    expect(result.code).toBe(0);
    expect(result.stdout.trimEnd().split('\n').at(-1)).toMatch(new RegExp(`^warn screen: .*; hint: ${hint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  });
});
