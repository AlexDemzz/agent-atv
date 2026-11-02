import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeApi, type FakeApi } from './support/fake-api.js';
import { createSandbox, type Sandbox } from './support/run-cli.js';
import { TOKEN, apiError } from './support/fixtures.js';

let api: FakeApi;
let sandbox: Sandbox;
const PAIRING_ID = 'p-0123456789ab';
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
};

beforeEach(async () => {
  api = await startFakeApi();
  sandbox = createSandbox({ AGENT_ATV_URL: api.url, AGENT_ATV_TOKEN: TOKEN });
});

afterEach(async () => {
  await api.close();
  sandbox.cleanup();
});

const STARTED = {
  pairingId: PAIRING_ID,
  device: { id: 'A1B2C3D4E5F6', name: 'Living Room' },
  protocol: 'companion',
  step: 1,
  steps: 2,
  message: 'Enter the 4-digit PIN shown on Living Room',
};

describe('pair without a TTY', () => {
  it('starts pairing and prints how to submit the PIN', async () => {
    api.on('POST', '/v1/devices/default/pair', { body: STARTED });

    const result = await sandbox.run(['pair']);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      `pairing ${PAIRING_ID} started (step 1/2, companion): run agent-atv pair --pairing ${PAIRING_ID} --pin <PIN>\n`,
    );
    expect(api.requests[0]?.body).toEqual({});
  });

  it('pairs the device named as an argument', async () => {
    api.on('POST', '/v1/devices/Living%20Room/pair', { body: STARTED });

    const result = await sandbox.run(['pair', 'Living Room', '--no-input']);

    expect(result.code).toBe(0);
  });

  it('submits a PIN and prints the next step', async () => {
    api.on('POST', `/v1/pairings/${PAIRING_ID}/pin`, {
      body: { status: 'next', pairingId: PAIRING_ID, protocol: 'airplay', step: 2, steps: 2, message: 'Enter the PIN' },
    });

    const result = await sandbox.run(['pair', '--pairing', PAIRING_ID, '--pin', '1234']);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      `pairing ${PAIRING_ID} started (step 2/2, airplay): run agent-atv pair --pairing ${PAIRING_ID} --pin <PIN>\n`,
    );
    expect(api.requests[0]?.body).toEqual({ pin: '1234' });
  });

  it('waits longer than the global HTTP timeout for a PIN, which may chain several Apple TV calls', async () => {
    api.on('POST', `/v1/pairings/${PAIRING_ID}/pin`, { body: { status: 'done', device: SUMMARY }, delayMs: 400 });

    const result = await sandbox.run(['pair', '--pairing', PAIRING_ID, '--pin', '5678', '--timeout', '100']);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('paired Living Room (A1B2C3D4E5F6)\n');
  });

  it('prints the paired device when done', async () => {
    api.on('POST', `/v1/pairings/${PAIRING_ID}/pin`, { body: { status: 'done', device: SUMMARY } });

    const result = await sandbox.run(['pair', '--pairing', PAIRING_ID, '--pin', '5678']);

    expect(result.stdout).toBe('paired Living Room (A1B2C3D4E5F6)\n');
  });

  it('prints the API body with --json', async () => {
    api.on('POST', '/v1/devices/default/pair', { body: STARTED });

    const result = await sandbox.run(['pair', '--json']);

    expect(JSON.parse(result.stdout)).toEqual(STARTED);
  });

  it.each([['123'], ['abcd']])('rejects the PIN %s with exit 2 before calling the API', async (pin) => {
    const result = await sandbox.run(['pair', '--pairing', PAIRING_ID, '--pin', pin]);

    expect(result.code).toBe(2);
    expect(api.requests).toHaveLength(0);
  });

  it('needs --pairing with --pin', async () => {
    expect((await sandbox.run(['pair', '--pin', '1234'])).code).toBe(2);
  });

  it('exits 1 on a wrong PIN', async () => {
    api.on('POST', `/v1/pairings/${PAIRING_ID}/pin`, {
      status: 422,
      body: apiError('PAIRING_FAILED', 'Wrong PIN', 'Start over with: agent-atv pair'),
    });

    const result = await sandbox.run(['pair', '--pairing', PAIRING_ID, '--pin', '0001']);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('hint: Start over with: agent-atv pair\n');
  });

  it('cancels a pairing', async () => {
    api.on('DELETE', `/v1/pairings/${PAIRING_ID}`, { body: { ok: true } });

    const result = await sandbox.run(['pair', '--cancel', PAIRING_ID]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`cancelled ${PAIRING_ID}\n`);
    expect(api.requests[0]?.method).toBe('DELETE');
  });
});

describe('unpair', () => {
  it('requires --yes without a TTY', async () => {
    const result = await sandbox.run(['unpair', 'Living Room']);

    expect(result.code).toBe(2);
    expect(api.requests).toHaveLength(0);
  });

  it('deletes the pairing with --yes', async () => {
    api.on('DELETE', '/v1/devices/Living%20Room/pairing', { body: { ok: true } });

    const result = await sandbox.run(['unpair', 'Living Room', '--yes']);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('unpaired Living Room\n');
  });

  it('needs a device', async () => {
    expect((await sandbox.run(['unpair', '--yes'])).code).toBe(2);
  });
});

describe('pair --screen', () => {
  it('pairs screen reading alone and accepts its longer PIN', async () => {
    api.on('POST', '/v1/devices/default/pair', {
      body: { ...STARTED, protocol: 'remotepairing', steps: 1, message: 'Enter the PIN shown on Living Room for screen reading' },
    });
    api.on('POST', `/v1/pairings/${PAIRING_ID}/pin`, { body: { status: 'done', device: SUMMARY } });

    const started = await sandbox.run(['pair', '--screen']);
    const done = await sandbox.run(['pair', '--pairing', PAIRING_ID, '--pin', '123456']);

    expect(api.requests[0]?.body).toEqual({ protocol: 'remotepairing' });
    expect(started.stdout).toBe(
      `pairing ${PAIRING_ID} started (step 1/1, remotepairing): run agent-atv pair --pairing ${PAIRING_ID} --pin <PIN>\n`,
    );
    expect([done.code, done.stdout]).toEqual([0, 'paired Living Room (A1B2C3D4E5F6)\n']);
    expect(api.requests[1]?.body).toEqual({ pin: '123456' });
  });

  it('prints the warning of a pairing that left screen reading out', async () => {
    const warning = 'Screen reading not paired (no PIN prompt): on the Apple TV open Settings > Remotes and Devices > Remote App and Devices, then run agent-atv pair A1B2C3D4E5F6 --screen';
    api.on('POST', `/v1/pairings/${PAIRING_ID}/pin`, { body: { status: 'done', device: SUMMARY, warning } });

    const result = await sandbox.run(['pair', '--pairing', PAIRING_ID, '--pin', '1234']);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('paired Living Room (A1B2C3D4E5F6)\n');
    expect(result.stderr).toBe(`warning: ${warning}\n`);
  });

  it.each(['123', '123456789', '12ab'])('rejects the PIN %s with exit 2', async (pin) => {
    const result = await sandbox.run(['pair', '--pairing', PAIRING_ID, '--pin', pin]);

    expect(result.code).toBe(2);
    expect(api.requests).toHaveLength(0);
  });
});
