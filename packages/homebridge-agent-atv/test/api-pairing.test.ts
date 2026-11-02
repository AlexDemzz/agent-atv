import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AIRPLAY_CREDS, COMPANION_CREDS, DEVICE_ID, GOOD_PIN, installAppleTv, type AppleTvOptions } from './support/apple-tv';
import { BridgeFailure, FakeBridge } from './support/fake-bridge';
import { RP_IDENTIFIER, RP_PIN, installScreen } from './support/fake-screen';
import { eventually, makeStorage, seedPairedDevice, startPlugin, stopAll, waitConnected } from './support/harness';

afterEach(stopAll);

async function discoveredPlugin(options: AppleTvOptions = {}) {
  const storagePath = await makeStorage();
  const bridge = new FakeBridge();
  const tv = installAppleTv(bridge, options);
  const plugin = await startPlugin({ spawnBridge: bridge.spawn, storagePath, config: { discovery: { enabled: true } } });
  await eventually(async () => (await plugin.get('/devices')).body.devices.length === 1);
  return { plugin, bridge, tv, storagePath };
}

const recordPath = (storagePath: string) => path.join(storagePath, 'agent-atv', 'devices', `${DEVICE_ID}.json`);
const readRecord = async (storagePath: string) => JSON.parse(await readFile(recordPath(storagePath), 'utf8'));

describe('pairing (P1)', () => {
  it('pairs Companion then AirPlay under one pairing id when the Companion credentials do not work for AirPlay', async () => {
    const { plugin, bridge, storagePath } = await discoveredPlugin();

    const begin = await plugin.post(`/devices/${DEVICE_ID}/pair`);
    expect(begin.status).toBe(200);
    expect(begin.body).toEqual({
      pairingId: expect.stringMatching(/^p-[0-9a-f]{12}$/),
      device: { id: DEVICE_ID, name: 'Living Room' },
      protocol: 'companion',
      step: 1,
      steps: 2,
      message: 'Enter the 4-digit PIN shown on Living Room',
    });
    expect(bridge.calls('pair.begin')).toEqual([
      { device: DEVICE_ID, address: '192.168.1.50', protocol: 'companion', remoteName: 'agent-atv (testhost)' },
    ]);
    const { pairingId } = begin.body;

    const next = await plugin.post(`/pairings/${pairingId}/pin`, { pin: GOOD_PIN });
    expect(next.body).toEqual({
      status: 'next',
      pairingId,
      protocol: 'airplay',
      step: 2,
      steps: 2,
      message: 'Enter the 4-digit PIN shown on Living Room',
    });
    expect(bridge.calls('pair.verify')).toEqual([
      { device: DEVICE_ID, address: '192.168.1.50', protocol: 'airplay', credentials: COMPANION_CREDS },
    ]);
    expect((await readRecord(storagePath)).credentials).toEqual({ companion: COMPANION_CREDS });

    const done = await plugin.post(`/pairings/${pairingId}/pin`, { pin: GOOD_PIN });
    expect(done.body).toEqual({
      status: 'done',
      device: expect.objectContaining({ id: DEVICE_ID, paired: true, needsPairing: false, connection: 'connected' }),
    });
    expect(bridge.calls('pair.begin').map((p) => p.protocol)).toEqual(['companion', 'airplay']);
    expect(bridge.calls('connect').at(-1)).toMatchObject({
      credentials: { companion: COMPANION_CREDS, airplay: AIRPLAY_CREDS },
    });

    const record = await readRecord(storagePath);
    expect(record).toMatchObject({
      id: DEVICE_ID,
      name: 'Living Room',
      address: '192.168.1.50',
      mac: 'A1:B2:C3:D4:E5:F6',
      model: 'Apple TV 4K (gen 3)',
      version: '27.2',
      credentials: { companion: COMPANION_CREDS, airplay: AIRPLAY_CREDS },
    });
    expect(record.pairedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect((await stat(recordPath(storagePath))).mode & 0o777).toBe(0o600);
    expect(JSON.stringify((await plugin.get('/devices')).body)).not.toContain(COMPANION_CREDS);
    expect(plugin.log.text).not.toContain(COMPANION_CREDS);
    expect(plugin.log.text).not.toContain(AIRPLAY_CREDS);
  });

  it('pairs default as the only known device, even though nothing is paired yet', async () => {
    const { plugin } = await discoveredPlugin();

    const begin = await plugin.post('/devices/default/pair');

    expect(begin.status).toBe(200);
    expect(begin.body.device).toEqual({ id: DEVICE_ID, name: 'Living Room' });
  });

  it('answers pair on default with AMBIGUOUS_DEVICE when several devices are known, paired or not', async () => {
    const storagePath = await makeStorage();
    await seedPairedDevice(storagePath);
    const bridge = new FakeBridge();
    installAppleTv(bridge);
    const plugin = await startPlugin({
      spawnBridge: bridge.spawn,
      storagePath,
      config: { devices: [{ id: 'B1B2C3D4E5F6', name: 'Bedroom' }] },
    });

    const response = await plugin.post('/devices/default/pair');

    expect([response.status, response.body.error.code]).toEqual([409, 'AMBIGUOUS_DEVICE']);
    expect(response.body.error.details.devices).toEqual(
      expect.arrayContaining([
        { id: DEVICE_ID, name: 'Living Room' },
        { id: 'B1B2C3D4E5F6', name: 'Bedroom' },
      ]),
    );
  });

  it('reuses the Companion credentials for AirPlay when pair.verify accepts them', async () => {
    const { plugin, bridge, storagePath } = await discoveredPlugin({ companionWorksForAirplay: true });

    const { pairingId } = (await plugin.post(`/devices/${DEVICE_ID}/pair`)).body;
    const done = await plugin.post(`/pairings/${pairingId}/pin`, { pin: GOOD_PIN });

    expect(done.body.status).toBe('done');
    expect(bridge.calls('pair.begin')).toHaveLength(1);
    expect((await readRecord(storagePath)).credentials).toEqual({ companion: COMPANION_CREDS, airplay: COMPANION_CREDS });
  });

  it('pairs a single protocol in one step when protocol is given', async () => {
    const { plugin, bridge } = await discoveredPlugin();

    const begin = await plugin.post(`/devices/${DEVICE_ID}/pair`, { protocol: 'companion' });
    expect(begin.body).toMatchObject({ protocol: 'companion', step: 1, steps: 1 });
    const done = await plugin.post(`/pairings/${begin.body.pairingId}/pin`, { pin: GOOD_PIN });

    expect(done.body.status).toBe('done');
    expect(bridge.calls('pair.verify')).toEqual([]);
    expect(bridge.calls('connect').at(-1)).toMatchObject({ credentials: { companion: COMPANION_CREDS } });
  });

  it('ends the session on a wrong PIN with 422 PAIRING_FAILED', async () => {
    const { plugin } = await discoveredPlugin();
    const { pairingId } = (await plugin.post(`/devices/${DEVICE_ID}/pair`)).body;

    const wrong = await plugin.post(`/pairings/${pairingId}/pin`, { pin: '9999' });
    expect([wrong.status, wrong.body.error.code]).toEqual([422, 'PAIRING_FAILED']);

    const again = await plugin.post(`/pairings/${pairingId}/pin`, { pin: GOOD_PIN });
    expect([again.status, again.body.error.code]).toEqual([404, 'PAIRING_NOT_FOUND']);
  });

  it('connects with the Companion credentials when the AirPlay step fails', async () => {
    const { plugin, bridge } = await discoveredPlugin();
    const { pairingId } = (await plugin.post(`/devices/${DEVICE_ID}/pair`)).body;
    expect((await plugin.post(`/pairings/${pairingId}/pin`, { pin: GOOD_PIN })).body.status).toBe('next');

    const wrong = await plugin.post(`/pairings/${pairingId}/pin`, { pin: '9999' });

    expect([wrong.status, wrong.body.error.code]).toEqual([422, 'PAIRING_FAILED']);
    await waitConnected(plugin);
    expect(bridge.calls('connect').at(-1)).toMatchObject({ credentials: { companion: COMPANION_CREDS } });
    expect(bridge.calls('connect').at(-1)).not.toHaveProperty('credentials.airplay');
  });

  it('answers PAIRING_BACKOFF with 429 and Retry-After', async () => {
    const { plugin } = await discoveredPlugin();
    const { pairingId } = (await plugin.post(`/devices/${DEVICE_ID}/pair`)).body;

    const response = await plugin.post(`/pairings/${pairingId}/pin`, { pin: '0000' });

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('30');
    expect(response.body.error).toMatchObject({ code: 'PAIRING_BACKOFF', details: { retryAfterSec: 30 } });
  });

  it('validates the PIN format and the protocol', async () => {
    const { plugin, bridge } = await discoveredPlugin();
    const { pairingId } = (await plugin.post(`/devices/${DEVICE_ID}/pair`)).body;

    for (const pin of ['123', '12345', 'abcd', 1234]) {
      const response = await plugin.post(`/pairings/${pairingId}/pin`, { pin });
      expect([response.status, response.body.error.details.field]).toEqual([400, 'pin']);
    }
    expect(bridge.calls('pair.pin')).toEqual([]);

    const badProtocol = await plugin.post(`/devices/${DEVICE_ID}/pair`, { protocol: 'mrp' });
    expect([badProtocol.status, badProtocol.body.error.details.field]).toEqual([400, 'protocol']);
  });

  it('refuses a second pairing for the same device while one is active, until it is cancelled', async () => {
    const { plugin, bridge } = await discoveredPlugin();
    const { pairingId } = (await plugin.post(`/devices/${DEVICE_ID}/pair`)).body;

    const second = await plugin.post(`/devices/${DEVICE_ID}/pair`);
    expect([second.status, second.body.error.code]).toEqual([409, 'PAIRING_IN_PROGRESS']);
    expect(second.body.error.details.pairingId).toBe(pairingId);

    expect((await plugin.request('DELETE', `/pairings/${pairingId}`)).body).toEqual({ ok: true });
    // The scripted Apple TV numbers its bridge pairing ids from p-000000000001.
    expect(bridge.calls('pair.cancel')).toEqual([{ pairingId: 'p-000000000001' }]);
    expect((await plugin.request('DELETE', `/pairings/${pairingId}`)).status).toBe(404);
    expect((await plugin.post(`/devices/${DEVICE_ID}/pair`)).status).toBe(200);
  });

  it('passes pair.begin failures through and leaves no session behind', async () => {
    const { plugin, bridge } = await discoveredPlugin();
    bridge.handle('pair.begin', () => {
      throw new BridgeFailure('DEVICE_NOT_FOUND', 'not found', { device: DEVICE_ID });
    });

    const response = await plugin.post(`/devices/${DEVICE_ID}/pair`);

    expect([response.status, response.body.error.code]).toEqual([404, 'DEVICE_NOT_FOUND']);
  });

  it('still answers done when connecting with the new credentials fails', async () => {
    const { plugin, bridge } = await discoveredPlugin();
    const { pairingId } = (await plugin.post(`/devices/${DEVICE_ID}/pair`, { protocol: 'companion' })).body;
    bridge.handle('connect', () => {
      throw new BridgeFailure('DEVICE_TIMEOUT', 'timeout');
    });

    const done = await plugin.post(`/pairings/${pairingId}/pin`, { pin: GOOD_PIN });

    expect(done.body).toMatchObject({ status: 'done', device: { paired: true, connection: 'connecting' } });
  });

  it('unpairs: disconnects, deletes the credentials and reports unpaired', async () => {
    const storagePath = await makeStorage();
    await seedPairedDevice(storagePath);
    const bridge = new FakeBridge();
    installAppleTv(bridge);
    const plugin = await startPlugin({ spawnBridge: bridge.spawn, storagePath });
    await waitConnected(plugin);

    const response = await plugin.request('DELETE', `/devices/${DEVICE_ID}/pairing`);

    expect(response.body).toEqual({ ok: true });
    expect(bridge.calls('disconnect')).toEqual([{ device: DEVICE_ID }]);
    expect((await readRecord(storagePath)).credentials).toEqual({});
    expect((await plugin.get('/devices')).body.devices[0]).toMatchObject({ paired: false, connection: 'unpaired' });
  });

  it('flags needsPairing and stops retrying when the Apple TV rejects the stored credentials', async () => {
    const storagePath = await makeStorage();
    await seedPairedDevice(storagePath, { credentials: { companion: 'stale' } });
    const bridge = new FakeBridge();
    installAppleTv(bridge);
    const plugin = await startPlugin({ spawnBridge: bridge.spawn, storagePath });

    const summary = await eventually(async () => {
      const device = (await plugin.get('/devices')).body.devices[0];
      return device.needsPairing ? device : null;
    });
    expect(summary).toMatchObject({ paired: true, needsPairing: true, connection: 'disconnected' });
    expect(plugin.log.at('warn')).toContain(
      `Living Room: credentials rejected, pair again in the plugin settings or with: agent-atv pair ${DEVICE_ID}`,
    );
    const action = await plugin.post(`/devices/${DEVICE_ID}/keys`, { keys: [{ key: 'up' }] });
    expect([action.status, action.body.error.code]).toEqual([503, 'AUTH_FAILED']);
    expect((await plugin.get(`/devices/${DEVICE_ID}/state`)).body.needsPairing).toBe(true);

    const { pairingId } = (await plugin.post(`/devices/${DEVICE_ID}/pair`, { protocol: 'companion' })).body;
    const done = await plugin.post(`/pairings/${pairingId}/pin`, { pin: GOOD_PIN });
    expect(done.body.device).toMatchObject({ needsPairing: false, connection: 'connected' });
    expect(bridge.calls('connect')).toHaveLength(2);
  });
});

describe('pairing with screen reading (P1)', () => {
  async function screenPairingPlugin(options: AppleTvOptions = {}, screenOptions: { paired?: boolean } = { paired: false }) {
    const storagePath = await makeStorage();
    const bridge = new FakeBridge();
    const tv = installAppleTv(bridge, options);
    const worker = new FakeBridge();
    const screen = installScreen(worker, screenOptions);
    const plugin = await startPlugin({
      spawnBridge: bridge.spawn,
      spawnScreen: worker.spawn,
      storagePath,
      config: { discovery: { enabled: true }, screen: { enabled: true } },
    });
    await eventually(async () => (await plugin.get('/devices')).body.devices.length === 1);
    await eventually(async () => (await plugin.get('/info')).body.screen.status === 'ready');
    return { plugin, bridge, tv, worker, screen, storagePath };
  }

  it('adds a RemotePairing step with its own PIN after Companion and AirPlay', async () => {
    const { plugin, worker, storagePath } = await screenPairingPlugin();

    const begin = await plugin.post(`/devices/${DEVICE_ID}/pair`);
    expect(begin.body).toMatchObject({ protocol: 'companion', step: 1, steps: 3 });
    const { pairingId } = begin.body;
    expect((await plugin.post(`/pairings/${pairingId}/pin`, { pin: GOOD_PIN })).body).toMatchObject({ protocol: 'airplay', step: 2 });

    const third = await plugin.post(`/pairings/${pairingId}/pin`, { pin: GOOD_PIN });
    expect(third.body).toEqual({
      status: 'next',
      pairingId,
      protocol: 'remotepairing',
      step: 3,
      steps: 3,
      message: 'Enter the PIN shown on Living Room for screen reading',
    });
    expect(worker.calls('pair.begin')).toHaveLength(1);

    const done = await plugin.post(`/pairings/${pairingId}/pin`, { pin: RP_PIN });
    expect(done.body).toMatchObject({ status: 'done', device: { paired: true, connection: 'connected' } });
    expect(done.body).not.toHaveProperty('warning');
    expect(worker.calls('pair.pin')).toEqual([{ pin: RP_PIN }]);
    expect((await readRecord(storagePath)).remotePairing).toEqual({ identifier: RP_IDENTIFIER });
    await eventually(async () => (await plugin.get('/devices')).body.devices[0].screen === 'connected');
  });

  it('goes from Companion straight to RemotePairing when the Companion credentials work for AirPlay', async () => {
    const { plugin } = await screenPairingPlugin({ companionWorksForAirplay: true });
    const { pairingId } = (await plugin.post(`/devices/${DEVICE_ID}/pair`)).body;

    const next = await plugin.post(`/pairings/${pairingId}/pin`, { pin: GOOD_PIN });

    expect(next.body).toMatchObject({ status: 'next', protocol: 'remotepairing', step: 3, steps: 3 });
  });

  it('finishes with a warning saying what to do when the Apple TV does not offer RemotePairing', async () => {
    const { plugin, worker, bridge } = await screenPairingPlugin({ companionWorksForAirplay: true });
    worker.handle('pair.begin', () => {
      throw new BridgeFailure(
        'PAIRING_FAILED',
        'The Apple TV does not offer RemotePairing right now: open Settings > Remotes and Devices > Remote App and Devices on it, then pair again',
      );
    });
    const { pairingId } = (await plugin.post(`/devices/${DEVICE_ID}/pair`)).body;

    const done = await plugin.post(`/pairings/${pairingId}/pin`, { pin: GOOD_PIN });

    expect(done.body).toMatchObject({ status: 'done', device: { paired: true } });
    expect(done.body.warning).toMatch(/^Screen reading not paired \(.*\): on the Apple TV open Settings > Remotes and Devices > Remote App and Devices, then run agent-atv pair A1B2C3D4E5F6 --screen$/);
    expect(bridge.calls('connect').at(-1)).toMatchObject({ credentials: { companion: COMPANION_CREDS } });
  });

  it('pairs screen reading alone with protocol remotepairing, leaving the remote connection alone', async () => {
    const storagePath = await makeStorage();
    await seedPairedDevice(storagePath);
    const bridge = new FakeBridge();
    installAppleTv(bridge);
    const worker = new FakeBridge();
    installScreen(worker, { paired: false });
    const plugin = await startPlugin({ spawnBridge: bridge.spawn, spawnScreen: worker.spawn, storagePath, config: { screen: { enabled: true } } });
    await waitConnected(plugin);
    await eventually(async () => (await plugin.get('/devices')).body.devices[0].screen === 'unpaired');
    const connects = bridge.calls('connect').length;

    const begin = await plugin.post(`/devices/${DEVICE_ID}/pair`, { protocol: 'remotepairing' });
    expect(begin.body).toMatchObject({ protocol: 'remotepairing', step: 1, steps: 1 });
    const done = await plugin.post(`/pairings/${begin.body.pairingId}/pin`, { pin: RP_PIN });

    expect(done.body.status).toBe('done');
    expect(bridge.calls('pair.begin')).toEqual([]);
    expect(bridge.calls('connect')).toHaveLength(connects);
  });

  it('wants 4 digits at a Companion step without ending the session', async () => {
    const { plugin } = await screenPairingPlugin();
    const { pairingId } = (await plugin.post(`/devices/${DEVICE_ID}/pair`)).body;

    const six = await plugin.post(`/pairings/${pairingId}/pin`, { pin: '123456' });
    expect([six.status, six.body.error.details.field]).toEqual([400, 'pin']);

    expect((await plugin.post(`/pairings/${pairingId}/pin`, { pin: GOOD_PIN })).body.status).toBe('next');
  });

  it('ends the session on a wrong RemotePairing PIN, keeping the remote pairing', async () => {
    const { plugin, worker } = await screenPairingPlugin({ companionWorksForAirplay: true });
    const { pairingId } = (await plugin.post(`/devices/${DEVICE_ID}/pair`)).body;
    await plugin.post(`/pairings/${pairingId}/pin`, { pin: GOOD_PIN });

    const wrong = await plugin.post(`/pairings/${pairingId}/pin`, { pin: '000000' });

    expect([wrong.status, wrong.body.error.code]).toEqual([422, 'PAIRING_FAILED']);
    expect((await plugin.get('/devices')).body.devices[0]).toMatchObject({ paired: true });
    expect(worker.calls('pair.pin')).toHaveLength(1);
  });

  it('cancels a RemotePairing step on the worker', async () => {
    const { plugin, worker } = await screenPairingPlugin();
    const { pairingId } = (await plugin.post(`/devices/${DEVICE_ID}/pair`, { protocol: 'remotepairing' })).body;

    expect((await plugin.request('DELETE', `/pairings/${pairingId}`)).body).toEqual({ ok: true });

    expect(worker.calls('pair.cancel')).toHaveLength(1);
  });

  it.each([true, false])('unpair deletes the RemotePairing record file (screen reading on: %s)', async (enabled) => {
    const storagePath = await makeStorage();
    await seedPairedDevice(storagePath, { remotePairing: { identifier: RP_IDENTIFIER } });
    const records = path.join(storagePath, 'agent-atv', 'pmd3-home', '.local', 'share', 'pymobiledevice3');
    await mkdir(records, { recursive: true });
    const recordFile = path.join(records, `remote_${RP_IDENTIFIER}.plist`);
    const otherFile = path.join(records, 'remote_OTHER.plist');
    await writeFile(recordFile, 'plist');
    await writeFile(otherFile, 'plist');
    const bridge = new FakeBridge();
    installAppleTv(bridge);
    const worker = new FakeBridge();
    worker.sendsReady = false;
    const plugin = await startPlugin({ spawnBridge: bridge.spawn, spawnScreen: worker.spawn, storagePath, config: { screen: { enabled } } });
    await waitConnected(plugin);

    await plugin.request('DELETE', `/devices/${DEVICE_ID}/pairing`);

    expect(existsSync(recordFile)).toBe(false);
    expect(existsSync(otherFile)).toBe(true);
    expect(await readRecord(storagePath)).not.toHaveProperty('remotePairing');
  });
});
