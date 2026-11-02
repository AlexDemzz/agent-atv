import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeApi, type FakeApi } from './support/fake-api.js';
import { createSandbox, type Sandbox } from './support/run-cli.js';
import { livingRoomState } from './support/fixtures.js';

let api: FakeApi;
let sandbox: Sandbox;

beforeEach(async () => {
  api = await startFakeApi();
  sandbox = createSandbox();
});

afterEach(async () => {
  await api.close();
  sandbox.cleanup();
});

function defaultConfigPath(): string {
  return join(sandbox.configHome, 'agent-atv', 'config.json');
}

function writeConfig(path: string, body: unknown, mode = 0o600): void {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(body));
  chmodSync(path, mode);
}

describe('config path', () => {
  it('uses XDG_CONFIG_HOME, then ~/.config, and AGENT_ATV_CONFIG overrides both', async () => {
    expect((await sandbox.run(['config', 'path'])).stdout).toBe(`${defaultConfigPath()}\n`);

    const noXdg = await sandbox.run(['config', 'path'], { env: { XDG_CONFIG_HOME: undefined } });
    expect(noXdg.stdout).toBe(`${join(sandbox.home, '.config', 'agent-atv', 'config.json')}\n`);

    const custom = join(sandbox.root, 'custom.json');
    const overridden = await sandbox.run(['config', 'path'], { env: { AGENT_ATV_CONFIG: custom } });
    expect(overridden.stdout).toBe(`${custom}\n`);
  });
});

describe('config set', () => {
  it('writes url and device to a 0600 file in a 0700 directory', async () => {
    const setUrl = await sandbox.run(['config', 'set', 'url', 'http://100.64.0.10:8787']);
    const setDevice = await sandbox.run(['config', 'set', 'device', 'Living Room']);

    expect(setUrl.code).toBe(0);
    expect(setDevice.code).toBe(0);
    const path = defaultConfigPath();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ url: 'http://100.64.0.10:8787', device: 'Living Room' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
  });

  it('reads the token from stdin with "-" and never echoes it', async () => {
    const result = await sandbox.run(['config', 'set', 'token', '-'], { stdin: 'secret-token-from-stdin-1234\n' });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain('secret-token-from-stdin-1234');
    expect(JSON.parse(readFileSync(defaultConfigPath(), 'utf8'))).toEqual({ token: 'secret-token-from-stdin-1234' });
  });

  it('accepts a literal token with a warning', async () => {
    const result = await sandbox.run(['config', 'set', 'token', 'literal-token-abcd']);

    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/^warning: .*config set token -/);
    expect(JSON.parse(readFileSync(defaultConfigPath(), 'utf8'))).toEqual({ token: 'literal-token-abcd' });
  });

  it('rejects an unknown key or an invalid url with exit 2', async () => {
    expect((await sandbox.run(['config', 'set', 'colour', 'blue'])).code).toBe(2);
    expect((await sandbox.run(['config', 'set', 'url', '192.168.1.20:8787'])).code).toBe(2);
  });
});

describe('config show', () => {
  it('reports each value with its source and masks the token', async () => {
    writeConfig(defaultConfigPath(), { url: 'http://file:8787', token: 'file-token-5678', device: 'Bedroom' });

    const result = await sandbox.run(['config', 'show', '--url', 'http://flag:8787'], {
      env: { AGENT_ATV_TOKEN: 'env-token-1234' },
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('url: http://flag:8787 (flag)\n');
    expect(result.stdout).toContain('token: …1234 (env)\n');
    expect(result.stdout).toContain('device: Bedroom (file)\n');
    expect(result.stdout).not.toContain('env-token-1234');
  });

  it('falls back to defaults', async () => {
    const result = await sandbox.run(['config', 'show', '--json']);

    const body = JSON.parse(result.stdout) as Record<string, { value: unknown; source: string }>;
    expect(body.device).toEqual({ value: 'default', source: 'default' });
    expect(body.url).toEqual({ value: null, source: 'default' });
    expect(body.token).toEqual({ value: null, source: 'default' });
  });

  it('warns when the config file is readable by others', async () => {
    writeConfig(defaultConfigPath(), { url: 'http://file:8787' }, 0o644);

    const result = await sandbox.run(['config', 'show']);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain(`warning: ${defaultConfigPath()}`);
  });
});

describe('precedence in requests', () => {
  it('uses url, token and device from the config file when no flag or env is set', async () => {
    writeConfig(defaultConfigPath(), { url: api.url, token: 'file-token', device: 'Living Room' });
    api.on('GET', '/v1/devices/Living%20Room/state?refresh=1&focus=1&app=1', { body: livingRoomState() });

    const result = await sandbox.run(['snapshot']);

    expect(result.code).toBe(0);
    expect(api.requests[0]?.headers.authorization).toBe('Bearer file-token');
  });

  it('lets env override the file and a flag override env', async () => {
    writeConfig(defaultConfigPath(), { url: 'http://127.0.0.1:1', token: 'file-token', device: 'Bedroom' });
    api.on('GET', '/v1/devices/Kitchen/state?refresh=1&focus=1&app=1', { body: livingRoomState() });

    const result = await sandbox.run(['snapshot', '--device', 'Kitchen'], {
      env: { AGENT_ATV_URL: api.url, AGENT_ATV_TOKEN: 'env-token', AGENT_ATV_DEVICE: 'Office' },
    });

    expect(result.code).toBe(0);
    expect(api.requests[0]?.headers.authorization).toBe('Bearer env-token');
  });
});
