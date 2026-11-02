import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeApi, type FakeApi } from './support/fake-api.js';
import { createSandbox, type Sandbox } from './support/run-cli.js';
import { TOKEN } from './support/fixtures.js';

let api: FakeApi;
let sandbox: Sandbox;
const APPS = [
  { bundleId: 'com.netflix.Netflix', name: 'Netflix' },
  { bundleId: 'com.apple.TVSearch', name: 'Search' },
  { bundleId: 'com.apple.TVSettings', name: 'Settings' },
  { bundleId: 'com.apple.TVWatchList', name: 'TV' },
  { bundleId: 'com.google.ios.youtube', name: 'YouTube' },
];

beforeEach(async () => {
  api = await startFakeApi();
  sandbox = createSandbox({ AGENT_ATV_URL: api.url, AGENT_ATV_TOKEN: TOKEN });
  api.on('GET', '/v1/devices/default/apps', { body: { apps: APPS } });
  api.on('GET', '/v1/devices/default/apps?refresh=1', { body: { apps: APPS } });
});

afterEach(async () => {
  await api.close();
  sandbox.cleanup();
});

describe('apps', () => {
  it('lists bundle id and name separated by two spaces', async () => {
    const result = await sandbox.run(['apps']);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      [
        'com.netflix.Netflix  Netflix',
        'com.apple.TVSearch  Search',
        'com.apple.TVSettings  Settings',
        'com.apple.TVWatchList  TV',
        'com.google.ios.youtube  YouTube',
        '',
      ].join('\n'),
    );
    expect(api.requests[0]?.path).toBe('/v1/devices/default/apps');
  });

  it('refreshes the list with --refresh', async () => {
    await sandbox.run(['apps', '--refresh']);

    expect(api.requests[0]?.path).toBe('/v1/devices/default/apps?refresh=1');
  });

  it('filters by name or bundle id, case-insensitively', async () => {
    const byName = await sandbox.run(['apps', '--filter', 'SET']);
    const byId = await sandbox.run(['apps', '--filter', 'google']);

    expect(byName.stdout).toBe('com.apple.TVSettings  Settings\n');
    expect(byId.stdout).toBe('com.google.ios.youtube  YouTube\n');
  });

  it('prints the (filtered) apps object with --json', async () => {
    const result = await sandbox.run(['apps', '--filter', 'tv', '--json']);

    expect(JSON.parse(result.stdout)).toEqual({
      apps: [
        { bundleId: 'com.apple.TVSearch', name: 'Search' },
        { bundleId: 'com.apple.TVSettings', name: 'Settings' },
        { bundleId: 'com.apple.TVWatchList', name: 'TV' },
      ],
    });
  });
});
