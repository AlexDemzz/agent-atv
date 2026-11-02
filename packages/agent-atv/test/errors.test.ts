import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeApi, type FakeApi } from './support/fake-api.js';
import { createSandbox, type Sandbox } from './support/run-cli.js';
import { TOKEN, apiError } from './support/fixtures.js';

let api: FakeApi;
let sandbox: Sandbox;
const STATE = '/v1/devices/default/state?refresh=1&focus=1&app=1';

beforeEach(async () => {
  api = await startFakeApi();
  sandbox = createSandbox({ AGENT_ATV_URL: api.url, AGENT_ATV_TOKEN: TOKEN });
});

afterEach(async () => {
  await api.close();
  sandbox.cleanup();
});

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('API errors', () => {
  it('prints error and hint lines on stderr in text mode', async () => {
    api.on('GET', STATE, {
      status: 409,
      body: apiError(
        'KEYBOARD_NOT_FOCUSED',
        'No text field is focused on Living Room',
        'Navigate to a text field and press select, then retry. Check with: agent-atv state keyboard',
      ),
    });

    const result = await sandbox.run(['snapshot']);

    expect(result.code).toBe(6);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'error: No text field is focused on Living Room (KEYBOARD_NOT_FOCUSED)\n' +
        'hint: Navigate to a text field and press select, then retry. Check with: agent-atv state keyboard\n',
    );
  });

  it('prints the error body on stdout and nothing on stderr with --json', async () => {
    const body = apiError('NOT_PAIRED', 'Living Room is not paired', 'Run agent-atv pair', { device: 'A1B2C3D4E5F6' });
    api.on('GET', STATE, { status: 409, body });

    const result = await sandbox.run(['snapshot', '--json']);

    expect(result.code).toBe(6);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual(body);
  });

  it.each([
    ['BAD_REQUEST', 400, 2],
    ['UNAUTHORIZED', 401, 4],
    ['DEVICE_NOT_FOUND', 404, 5],
    ['AMBIGUOUS_DEVICE', 409, 5],
    ['WAIT_TIMEOUT', 408, 7],
    ['BRIDGE_UNAVAILABLE', 503, 6],
    ['SCREEN_FAILED', 502, 8],
    ['SCREEN_NOT_PAIRED', 503, 8],
    ['FOCUS_UNKNOWN', 409, 8],
    ['DEVICE_ERROR', 502, 1],
    ['PAIRING_FAILED', 422, 1],
  ])('maps %s to exit code %i', async (code, status, exit) => {
    api.on('GET', STATE, { status: Number(status), body: apiError(String(code), 'failed', 'do something') });

    const result = await sandbox.run(['snapshot']);

    expect(result.code).toBe(exit);
    expect(result.stderr).toContain(`(${code})`);
  });

  it('exits 3 on a 5xx response without a JSON error body', async () => {
    api.on('GET', STATE, { status: 502, raw: '<html>Bad Gateway</html>', headers: { 'content-type': 'text/html' } });

    const result = await sandbox.run(['snapshot']);

    expect(result.code).toBe(3);
  });
});

describe('CLI-side errors', () => {
  it('reports CONNECTION_FAILED with exit 3 when nothing listens', async () => {
    const url = `http://127.0.0.1:${await unusedPort()}`;

    const result = await sandbox.run(['snapshot', '--json'], { env: { AGENT_ATV_URL: url } });

    expect(result.code).toBe(3);
    const body = JSON.parse(result.stdout) as { error: { code: string; hint: string } };
    expect(body.error.code).toBe('CONNECTION_FAILED');
    expect(body.error.hint).toBe(
      `Run agent-atv doctor; if ${url} stays unreachable, ask the user whether Homebridge is running.`,
    );
  });

  it('reports TIMEOUT with exit 3 when the API is slower than --timeout', async () => {
    api.on('GET', STATE, { body: {}, delayMs: 2000 });

    const result = await sandbox.run(['snapshot', '--timeout', '200', '--json']);

    expect(result.code).toBe(3);
    expect((JSON.parse(result.stdout) as { error: { code: string } }).error.code).toBe('TIMEOUT');
  });

  it('reports CONFIG_MISSING with exit 2 and the config hint when no url is set', async () => {
    const result = await sandbox.run(['snapshot'], { env: { AGENT_ATV_URL: undefined } });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('(CONFIG_MISSING)\n');
    expect(result.stderr).toContain('hint: run agent-atv config set url http://<homebridge-host>:8787\n');
  });

  it('reports USAGE with exit 2 for an unknown command or option', async () => {
    const command = await sandbox.run(['dance', '--json']);
    expect(command.code).toBe(2);
    expect((JSON.parse(command.stdout) as { error: { code: string } }).error.code).toBe('USAGE');

    const option = await sandbox.run(['snapshot', '--bogus']);
    expect(option.code).toBe(2);
    expect(option.stderr).toContain('(USAGE)');
  });

  it('warns on stderr when the token comes from the command line', async () => {
    api.on('GET', STATE, { status: 401, body: apiError('UNAUTHORIZED', 'Missing or invalid token', 'Check the token') });

    const result = await sandbox.run(['snapshot', '--token', 'from-flag', '--json']);

    expect(result.stderr).toBe(
      'warning: --token is visible in shell history; prefer AGENT_ATV_TOKEN or agent-atv config set token -\n',
    );
    expect(api.requests[0]?.headers.authorization).toBe('Bearer from-flag');
  });
});

describe('help and version', () => {
  it('prints the package version', async () => {
    const result = await sandbox.run(['--version']);
    expect(result.code).toBe(0);
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(result.stdout).toBe(`${version}\n`);
  });

  it('lists commands with --help and points agents at the core skill', async () => {
    const result = await sandbox.run(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('snapshot');
    expect(result.stdout).toContain('agent-atv skills get core');
  });
});
