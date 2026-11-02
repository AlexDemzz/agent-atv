import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeApi, type FakeApi } from './support/fake-api.js';
import { createSandbox, type Sandbox } from './support/run-cli.js';
import { TOKEN } from './support/fixtures.js';

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

const LIVING_ROOM = {
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

describe('devices', () => {
  it('prints one line per device', async () => {
    api.on('GET', '/v1/devices', {
      body: {
        devices: [
          LIVING_ROOM,
          { ...LIVING_ROOM, id: 'B2C3D4E5F6A1', name: 'Bedroom', address: '192.168.1.51', paired: false, connection: 'unpaired' },
        ],
      },
    });

    const result = await sandbox.run(['devices']);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      'A1B2C3D4E5F6  Living Room  connected  paired  tvOS 27.2  192.168.1.50\n' +
        'B2C3D4E5F6A1  Bedroom  unpaired  unpaired  tvOS 27.2  192.168.1.51\n',
    );
  });
});

describe('scan', () => {
  it('posts a scan and prints the found devices with their pairing status', async () => {
    api.on('POST', '/v1/scan', {
      body: {
        devices: [
          {
            id: 'A1B2C3D4E5F6',
            name: 'Living Room',
            address: '192.168.1.50',
            mac: 'A1:B2:C3:D4:E5:F6',
            model: 'Apple TV 4K (gen 3)',
            os: 'tvOS',
            version: '27.2',
            identifiers: ['A1B2C3D4E5F6'],
            services: [],
            paired: false,
          },
        ],
      },
    });

    const result = await sandbox.run(['scan']);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('A1B2C3D4E5F6  Living Room  unpaired  tvOS 27.2  192.168.1.50\n');
    expect(api.requests[0]?.body).toEqual({});
  });
});
