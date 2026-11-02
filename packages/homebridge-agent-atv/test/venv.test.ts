import { rmSync } from 'node:fs';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureVenv } from '../src/python/venv';
import { FakeBridge, delay } from './support/fake-bridge';
import { FakePython } from './support/fake-python';
import { RecordingLogger, eventually, makeStorage, seedPairedDevice, startPlugin, stopAll } from './support/harness';

afterEach(stopAll);

const REQUIREMENTS = ['# pinned', 'pyatv==0.18.0', 'typing_extensions==4.16.0', 'Zeroconf==0.150.0', ''];

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-atv-venv-'));
  const pluginDir = path.join(root, 'agent-atv');
  const requirementsPath = path.join(root, 'requirements.txt');
  await writeFile(requirementsPath, REQUIREMENTS.join('\n'));
  const python = new FakePython(pluginDir);
  python.requirementsInstalled = ['pyatv==0.18.0', 'typing-extensions==4.16.0', 'zeroconf==0.150.0'];
  const log = new RecordingLogger();
  const ensure = (force = false) =>
    ensureVenv({ pluginDir, python: 'python3', requirementsPath, force, run: python.run, log });
  return { root, pluginDir, python, log, ensure, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('ensureVenv (P4)', () => {
  it('creates the venv in <pluginDir>/.venv and installs the pinned requirements', async () => {
    const { python, pluginDir, ensure, cleanup } = await setup();

    const result = await ensure();

    expect(result).toEqual({ python: path.join(pluginDir, '.venv', 'bin', 'python3') });
    expect((await stat(pluginDir)).mode & 0o777).toBe(0o700);
    const commands = python.commands();
    expect(commands).toContain(`python3 -m venv ${path.join(pluginDir, '.venv')} --clear`);
    expect(commands.some((c) => c.endsWith('-m pip install --upgrade pip'))).toBe(true);
    const install = python.calls.find((c) => c.args.join(' ').startsWith('-m pip install -r'))!;
    expect(install.args.at(-1)).toMatch(/requirements\.txt$/);
    expect(install.timeoutMs).toBe(300_000);
    cleanup();
  });

  it('skips creation and install when the venv matches the system Python and the requirements', async () => {
    const { python, ensure, cleanup } = await setup();
    python.createExistingVenv(['pip==25.0', 'pyatv==0.18.0', 'typing-extensions==4.16.0', 'zeroconf==0.150.0']);

    await ensure();

    expect(python.commands().some((c) => c.includes('-m venv') || c.includes('pip install'))).toBe(false);
    cleanup();
  });

  it('reinstalls when an installed version differs from requirements.txt', async () => {
    const { python, ensure, cleanup } = await setup();
    python.createExistingVenv(['pyatv==0.17.0', 'typing-extensions==4.16.0', 'zeroconf==0.150.0']);

    await ensure();

    expect(python.commands().some((c) => c.includes('-m venv'))).toBe(false);
    expect(python.commands().some((c) => c.includes('-m pip install -r'))).toBe(true);
    cleanup();
  });

  it.each([
    ['a missing pip3', (p: FakePython) => rmSync(path.join(p.venvDir, 'bin', 'pip3'))],
    ['a missing pyvenv.cfg', (p: FakePython) => rmSync(path.join(p.venvDir, 'pyvenv.cfg'))],
    ['another base interpreter', (p: FakePython) => (p.venvBaseExecutable = '/usr/bin/python3.10')],
    ['another Python version', (p: FakePython) => (p.venvVersion = '3.11.1')],
  ])('recreates the venv for %s', async (_reason, breakVenv) => {
    const { python, pluginDir, ensure, cleanup } = await setup();
    python.createExistingVenv(python.requirementsInstalled);
    breakVenv(python);

    await ensure();

    expect(python.commands()).toContain(`python3 -m venv ${path.join(pluginDir, '.venv')} --clear`);
    cleanup();
  });

  it('recreates the venv when forced', async () => {
    const { python, ensure, cleanup } = await setup();
    python.createExistingVenv(python.requirementsInstalled);

    await ensure(true);

    expect(python.commands().some((c) => c.includes('-m venv'))).toBe(true);
    cleanup();
  });

  it.each(['3.9.18', '3.14.0'])('refuses Python %s with the supported range', async (version) => {
    const { python, ensure, cleanup } = await setup();
    python.systemVersion = version;

    await expect(ensure()).rejects.toThrow(/3\.10.*3\.13/);
    expect(python.commands().some((c) => c.includes('-m venv'))).toBe(false);
    cleanup();
  });

  it('explains a missing interpreter', async () => {
    const { python, ensure, cleanup } = await setup();
    python.versionOutput = '';

    await expect(ensure()).rejects.toThrow(/python\.executable/);
    cleanup();
  });

  it('points at python3-venv when the venv cannot be created', async () => {
    const { python, ensure, cleanup } = await setup();
    python.venvCreateError = 'The virtual environment was not created successfully because ensurepip is not available.';

    await expect(ensure()).rejects.toThrow(/python3-venv/);
    cleanup();
  });

  it('refuses OpenSSL older than 3.0 and only warns when the version is unreadable', async () => {
    const old = await setup();
    old.python.openssl = 'OpenSSL 1.1.1w  11 Sep 2023';
    await expect(old.ensure()).rejects.toThrow(/OpenSSL 1\.1\.1.*3\.0/);
    old.cleanup();

    const odd = await setup();
    odd.python.openssl = 'LibreSSL something';
    await expect(odd.ensure()).resolves.toBeDefined();
    expect(odd.log.at('warn').join('\n')).toMatch(/OpenSSL/);
    odd.cleanup();
  });

  it('builds the screen worker venv next to the bridge one from requirements-screen.txt', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-atv-venv-'));
    const pluginDir = path.join(root, 'agent-atv');
    const requirementsPath = path.join(root, 'requirements-screen.txt');
    await writeFile(requirementsPath, '# pinned\npymobiledevice3==11.49.1\n');
    const python = new FakePython(pluginDir, '.venv-screen');
    python.requirementsInstalled = ['pymobiledevice3==11.49.1'];
    const log = new RecordingLogger();
    const ensure = () =>
      ensureVenv({ pluginDir, venvName: '.venv-screen', purpose: 'the screen worker', python: 'python3', requirementsPath, force: false, run: python.run, log });

    expect(await ensure()).toEqual({ python: path.join(pluginDir, '.venv-screen', 'bin', 'python3') });
    expect(python.commands()).toContain(`python3 -m venv ${path.join(pluginDir, '.venv-screen')} --clear`);
    expect(log.at('info').join('\n')).toContain('the screen worker Python packages');

    python.calls.length = 0;
    await ensure();
    expect(python.commands().some((c) => c.includes('-m venv') || c.includes('pip install'))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('warns but continues when upgrading pip fails, and fails with the pip output when the install fails', async () => {
    const upgrade = await setup();
    upgrade.python.pipUpgradeError = 'network down';
    await expect(upgrade.ensure()).resolves.toBeDefined();
    expect(upgrade.log.at('warn').join('\n')).toMatch(/pip/);
    upgrade.cleanup();

    const install = await setup();
    install.python.pipInstallError = 'ERROR: No matching distribution found for pyatv==0.18.0';
    await expect(install.ensure()).rejects.toThrow(/No matching distribution found/);
    install.cleanup();
  });
});

describe('venv failure in the core (P1)', () => {
  it('starts the API anyway and reports the bridge as error without spawning it', async () => {
    const bridge = new FakeBridge();
    const plugin = await startPlugin({
      spawnBridge: bridge.spawn,
      env: { ...process.env, AGENT_ATV_FAKE_BRIDGE: undefined },
      config: { python: { executable: '/nonexistent/python3' }, discovery: { enabled: true } },
    });

    const info = await plugin.get('/info');
    await delay(50);

    expect(info.status).toBe(200);
    expect(info.body.bridge.status).toBe('error');
    expect(info.body.bridge.error).toMatch(/\/nonexistent\/python3/);
    expect(bridge.spawns).toEqual([]);
    expect(plugin.log.at('error')).toHaveLength(1);
    expect(plugin.log.at('warn')).toEqual([]);
  });
});

describe('screen venv failure in the core (P1)', () => {
  it('reports screen reading as not installed, with the reason, and answers SCREEN_NOT_CONFIGURED', async () => {
    const storagePath = await makeStorage();
    await seedPairedDevice(storagePath);
    const bridge = new FakeBridge();
    const worker = new FakeBridge();
    const plugin = await startPlugin({
      storagePath,
      spawnBridge: bridge.spawn,
      spawnScreen: worker.spawn,
      env: { ...process.env, AGENT_ATV_FAKE_BRIDGE: undefined },
      config: { python: { executable: '/nonexistent/python3' }, screen: { enabled: true } },
    });

    const info = await eventually(async () => {
      const body = (await plugin.get('/info')).body;
      return body.screen.status === 'error' ? body : null;
    });

    expect(info.screen.reason).toMatch(/\/nonexistent\/python3/);
    const focus = await plugin.get('/devices/default/focus');
    expect([focus.status, focus.body.error.code]).toEqual([503, 'SCREEN_NOT_CONFIGURED']);
    expect(focus.body.error.message).toMatch(/^Screen reading could not be installed: .*\/nonexistent\/python3/);
    expect(worker.spawns).toEqual([]);
    expect(plugin.log.at('error').join('\n')).toMatch(/Screen reading is unavailable/);
  });
});
