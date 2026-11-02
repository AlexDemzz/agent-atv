import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeApi, type FakeApi } from './support/fake-api.js';
import { createSandbox, type Sandbox } from './support/run-cli.js';
import { TOKEN, apiError, livingRoomState } from './support/fixtures.js';

let api: FakeApi;
let sandbox: Sandbox;
const DEVICE = '/v1/devices/default';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake image body')]);
const SHA = createHash('sha256').update(PNG).digest('hex');

function pngReply() {
  return {
    raw: PNG,
    headers: {
      'content-type': 'image/png',
      'x-agent-atv-sha256': SHA,
      'x-agent-atv-width': '3840',
      'x-agent-atv-height': '2160',
      'x-agent-atv-captured-at': '2026-11-01T15:04:05.123Z',
      'x-agent-atv-duration-ms': '2100',
    },
  };
}

function screenshotBodies(): unknown[] {
  return api.requests.filter((request) => request.path === `${DEVICE}/screenshot`).map((request) => request.body);
}

function cachePath(): string {
  return join(sandbox.cacheHome, 'agent-atv', 'last-screenshot.json');
}

beforeEach(async () => {
  api = await startFakeApi();
  sandbox = createSandbox({ AGENT_ATV_URL: api.url, AGENT_ATV_TOKEN: TOKEN });
  api.on('GET', `${DEVICE}/state`, { body: livingRoomState() });
  api.on('GET', `${DEVICE}/state?refresh=1&focus=1&app=1`, { body: livingRoomState() });
});

afterEach(async () => {
  await api.close();
  sandbox.cleanup();
});

describe('screenshot', () => {
  it('writes the PNG to the given path and prints size and duration', async () => {
    api.on('POST', `${DEVICE}/screenshot`, pngReply());
    const path = join(sandbox.root, 'shots', 'tv.png');

    const result = await sandbox.run(['screenshot', path]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${path} (3840x2160, 2.1s)\n`);
    expect(readFileSync(path)).toEqual(PNG);
    expect(screenshotBodies()).toEqual([{}]);
  });

  it('defaults to a timestamped file under the temp directory', async () => {
    api.on('POST', `${DEVICE}/screenshot`, pngReply());

    const result = await sandbox.run(['screenshot']);

    const printed = result.stdout.split(' (')[0] as string;
    expect(printed.startsWith(join(sandbox.tmp, 'agent-atv', 'screenshot-A1B2C3D4E5F6-'))).toBe(true);
    expect(printed).toMatch(/screenshot-A1B2C3D4E5F6-\d{8}-\d{6}\.png$/);
    expect(readFileSync(printed)).toEqual(PNG);
  });

  it('keeps a device id from the server out of the default path and the directory private', async () => {
    api.on('GET', `${DEVICE}/state`, { body: livingRoomState({ device: { id: '/../../../evil/x', name: 'Evil' } }) });
    api.on('POST', `${DEVICE}/screenshot`, pngReply());

    const result = await sandbox.run(['screenshot']);

    expect(result.code).toBe(0);
    const dir = join(sandbox.tmp, 'agent-atv');
    expect(readdirSync(dir)).toEqual([expect.stringMatching(/^screenshot-_\.\._\.\._\.\._evil_x-\d{8}-\d{6}\.png$/)]);
    expect(result.stdout.startsWith(`${dir}/screenshot-`)).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('waits longer than the global HTTP timeout for a capture, which may reconnect the tunnel first', async () => {
    api.on('POST', `${DEVICE}/screenshot`, { ...pngReply(), delayMs: 400 });
    const path = join(sandbox.root, 'slow.png');

    const result = await sandbox.run(['screenshot', path, '--timeout', '100']);

    expect(result.code).toBe(0);
    expect(readFileSync(path)).toEqual(PNG);
  });

  it('records the last capture per device id and sends it with --if-changed', async () => {
    api.on('POST', `${DEVICE}/screenshot`, pngReply(), { status: 304, raw: '' });
    const first = join(sandbox.root, 'first.png');
    const second = join(sandbox.root, 'second.png');

    await sandbox.run(['screenshot', first]);
    const result = await sandbox.run(['screenshot', second, '--if-changed']);

    expect(JSON.parse(readFileSync(cachePath(), 'utf8'))).toEqual({ A1B2C3D4E5F6: { sha256: SHA, path: first } });
    expect(screenshotBodies()).toEqual([{}, { ifNoneMatch: SHA }]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`unchanged ${first}\n`);
    expect(existsSync(second)).toBe(false);
  });

  it('reports unchanged captures in JSON', async () => {
    mkdirSync(join(sandbox.cacheHome, 'agent-atv'), { recursive: true });
    writeFileSync(cachePath(), JSON.stringify({ A1B2C3D4E5F6: { sha256: SHA, path: '/old/shot.png' } }));
    api.on('POST', `${DEVICE}/screenshot`, { status: 304, raw: '' });

    const result = await sandbox.run(['screenshot', '--if-changed', '--json']);

    expect(JSON.parse(result.stdout)).toEqual({ changed: false, sha256: SHA, path: '/old/shot.png' });
  });

  it('sends no ifNoneMatch when there is no previous capture', async () => {
    api.on('POST', `${DEVICE}/screenshot`, pngReply());

    await sandbox.run(['screenshot', join(sandbox.root, 'a.png'), '--if-changed']);

    expect(screenshotBodies()).toEqual([{}]);
  });

  it('prints path, sha256 and size with --json', async () => {
    api.on('POST', `${DEVICE}/screenshot`, pngReply());
    const path = join(sandbox.root, 'a.png');

    const result = await sandbox.run(['screenshot', path, '--json']);

    expect(JSON.parse(result.stdout)).toEqual({ path, sha256: SHA, width: 3840, height: 2160, changed: true });
  });

  it('exits 8 with the hint when screen reading is not paired', async () => {
    api.on('POST', `${DEVICE}/screenshot`, {
      status: 503,
      body: apiError('SCREEN_NOT_PAIRED', 'Screen reading is not paired on Living Room', 'run agent-atv pair A1B2C3D4E5F6 --screen'),
    });

    const result = await sandbox.run(['screenshot']);

    expect(result.code).toBe(8);
    expect(result.stderr).toBe(
      'error: Screen reading is not paired on Living Room (SCREEN_NOT_PAIRED)\nhint: run agent-atv pair A1B2C3D4E5F6 --screen\n',
    );
  });
});

describe('snapshot --screenshot', () => {
  it('adds a Screenshot line', async () => {
    api.on('POST', `${DEVICE}/screenshot`, pngReply());
    const path = join(sandbox.root, 'snap.png');

    const result = await sandbox.run(['snapshot', '--screenshot', path]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Seq: 182\n');
    expect(result.stdout.trimEnd().split('\n').at(-1)).toBe(`Screenshot: ${path} (3840x2160)`);
    expect(readFileSync(path)).toEqual(PNG);
  });

  it('uses the default path when --screenshot has no value', async () => {
    api.on('POST', `${DEVICE}/screenshot`, pngReply());

    const result = await sandbox.run(['snapshot', '--screenshot']);

    expect(result.stdout).toMatch(/Screenshot: .*screenshot-A1B2C3D4E5F6-\d{8}-\d{6}\.png \(3840x2160\)\n$/);
  });

  it('still succeeds when the screenshot fails', async () => {
    api.on('POST', `${DEVICE}/screenshot`, {
      status: 503,
      body: apiError('SCREEN_NOT_PAIRED', 'Screen reading is not paired on Living Room', 'run agent-atv pair A1B2C3D4E5F6 --screen'),
    });

    const result = await sandbox.run(['snapshot', '--screenshot']);

    expect(result.code).toBe(0);
    expect(result.stdout.trimEnd().split('\n').at(-1)).toBe(
      'Screenshot: unavailable, screen reading not paired: run agent-atv pair A1B2C3D4E5F6 --screen',
    );
  });

  it('still succeeds when the screenshot cannot be written', async () => {
    api.on('POST', `${DEVICE}/screenshot`, pngReply());
    writeFileSync(join(sandbox.root, 'a-file'), '');

    const result = await sandbox.run(['snapshot', '--screenshot', join(sandbox.root, 'a-file', 'snap.png')]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Seq: 182\n');
    expect(result.stdout.trimEnd().split('\n').at(-1)).toMatch(/^Screenshot: unavailable, Cannot write the screenshot to .*: pass a writable path, e\.g\. agent-atv screenshot \.\/tv\.png$/);
  });

  it('nests the screenshot or its error in the JSON state', async () => {
    api.on('POST', `${DEVICE}/screenshot`, pngReply());
    const path = join(sandbox.root, 'snap.png');
    const ok = JSON.parse((await sandbox.run(['snapshot', '--screenshot', path, '--json'])).stdout) as Record<string, unknown>;
    expect(ok.seq).toBe(182);
    expect(ok.screenshot).toEqual({ path, sha256: SHA, width: 3840, height: 2160 });

    const failure = apiError('DEVICE_OFF', 'Living Room is off', 'agent-atv power on');
    api.on('POST', `${DEVICE}/screenshot`, { status: 409, body: failure });
    const failed = JSON.parse((await sandbox.run(['snapshot', '--screenshot', '--json'])).stdout) as Record<string, unknown>;
    expect(failed.screenshot).toEqual(failure);
  });
});
