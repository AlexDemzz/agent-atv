import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeApi, type FakeApi } from './support/fake-api.js';
import { createSandbox, type Sandbox } from './support/run-cli.js';
import { TOKEN, apiError, livingRoomState } from './support/fixtures.js';

let api: FakeApi;
let sandbox: Sandbox;
const OPEN = '/v1/devices/default/open';
const NETFLIX = { bundleId: 'com.netflix.Netflix', name: 'Netflix' };

beforeEach(async () => {
  api = await startFakeApi();
  sandbox = createSandbox({ AGENT_ATV_URL: api.url, AGENT_ATV_TOKEN: TOKEN });
});

afterEach(async () => {
  await api.close();
  sandbox.cleanup();
});

describe('open', () => {
  it('opens an app by name and waits 15000ms for it by default', async () => {
    api.on('POST', OPEN, { body: { ok: true, app: NETFLIX, foreground: true, state: livingRoomState() } });

    const result = await sandbox.run(['open', 'Netflix']);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('opened Netflix (com.netflix.Netflix)\n');
    expect(api.requests[0]?.body).toEqual({ target: 'Netflix', waitMs: 15000 });
  });

  it('does not wait with --no-wait', async () => {
    const search = { bundleId: 'com.apple.TVSearch', name: 'Search' };
    api.on('POST', OPEN, { body: { ok: true, app: search, foreground: false, state: livingRoomState() } });

    const result = await sandbox.run(['open', 'com.apple.TVSearch', '--no-wait']);

    expect(result.stdout).toBe('launched com.apple.TVSearch\n');
    expect(api.requests[0]?.body).toEqual({ target: 'com.apple.TVSearch', waitMs: 0 });
  });

  it('succeeds but says so when the app is not in the foreground after the wait', async () => {
    api.on('POST', OPEN, { body: { ok: true, app: NETFLIX, foreground: false, state: livingRoomState({ app: null }) } });

    const byDefault = await sandbox.run(['open', 'com.netflix.Netflix']);
    const custom = await sandbox.run(['open', 'com.netflix.Netflix', '--wait-ms', '5000']);

    expect(byDefault.code).toBe(0);
    expect(byDefault.stdout).toBe('launched com.netflix.Netflix (not in foreground after 15000ms)\n');
    expect(custom.stdout).toBe('launched com.netflix.Netflix (not in foreground after 5000ms)\n');
    expect(api.requests[1]?.body).toEqual({ target: 'com.netflix.Netflix', waitMs: 5000 });
  });

  it('returns at once and says how to know when screen reading cannot tell the foreground app', async () => {
    api.on('POST', OPEN, {
      body: {
        ok: true,
        app: NETFLIX,
        foreground: null,
        foregroundUnknown: {
          code: 'SCREEN_NOT_CONFIGURED',
          reason: 'screen reading off',
          hint: 'enable "Screen reading" in the agent-atv plugin settings',
        },
        state: livingRoomState(),
      },
    });

    const result = await sandbox.run(['open', 'Netflix']);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      'launched com.netflix.Netflix (foreground app not known, screen reading off: enable "Screen reading" in the agent-atv plugin settings)\n',
    );
  });

  it('launches a URL', async () => {
    api.on('POST', OPEN, { body: { ok: true, app: null, foreground: false, state: livingRoomState() } });

    const result = await sandbox.run(['open', 'https://www.netflix.com/title/80057281']);

    expect(result.stdout).toBe('launched https://www.netflix.com/title/80057281\n');
  });

  it('exits 5 when the app name is ambiguous', async () => {
    api.on('POST', OPEN, {
      status: 409,
      body: apiError('AMBIGUOUS_APP', '"Apple" matches several apps', 'Use a bundle id from: agent-atv apps', {
        matches: [NETFLIX],
      }),
    });

    const result = await sandbox.run(['open', 'Apple']);

    expect(result.code).toBe(5);
  });

  it('needs a target', async () => {
    expect((await sandbox.run(['open'])).code).toBe(2);
  });
});
