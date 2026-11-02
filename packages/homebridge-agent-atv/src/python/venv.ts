import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureDir } from '../fs-util';
import type { Logger } from '../logger';

export interface RunResult {
  /** Null when the process could not start or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
}
export type Run = (
  cmd: string,
  args: string[],
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv },
) => Promise<RunResult>;

export interface EnsureVenvOptions {
  pluginDir: string;
  /** Directory name under pluginDir; default `.venv`. */
  venvName?: string;
  /** What the packages are for, in log and error messages; default "the bridge's". */
  purpose?: string;
  python: string;
  requirementsPath: string;
  force: boolean;
  run: Run;
  log: Logger;
}

export class VenvError extends Error {}

const SHORT_TIMEOUT_MS = 30_000;
const VENV_TIMEOUT_MS = 120_000;
const PIP_UPGRADE_TIMEOUT_MS = 120_000;
const PIP_INSTALL_TIMEOUT_MS = 300_000;
const OUTPUT_LIMIT = 256 * 1024;

const SYSTEM_PROBE = 'import os, sys; print(os.path.realpath(sys.executable)); print("%d.%d.%d" % sys.version_info[:3])';
const VENV_PROBE = 'import os, sys; print(os.path.realpath(sys._base_executable)); print("%d.%d.%d" % sys.version_info[:3])';
const SSL_PROBE = 'import ssl; print(ssl.OPENSSL_VERSION)';

const tail = (text: string, lines = 15): string => text.trim().split('\n').slice(-lines).join('\n');

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

const normalizeRequirement = (line: string): string => {
  const [name = '', version = ''] = line.split('==');
  return `${name.trim().toLowerCase().replace(/[_.]+/g, '-')}==${version.trim()}`;
};

function requirementLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line !== '' && !line.startsWith('-') && line.includes('=='))
    .map(normalizeRequirement);
}

/** Creates or repairs `<pluginDir>/.venv` with the pinned bridge requirements (DESIGN.md §5.2). */
export async function ensureVenv(options: EnsureVenvOptions): Promise<{ python: string }> {
  const { pluginDir, python, requirementsPath, force, run, log } = options;
  const purpose = options.purpose ?? "the bridge's";
  await ensureDir(pluginDir);
  const venv = path.join(pluginDir, options.venvName ?? '.venv');
  const venvPython = path.join(venv, 'bin', 'python3');
  const env = { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1', PYTHONNOUSERSITE: '1' };

  const version = await run(python, ['--version'], { timeoutMs: SHORT_TIMEOUT_MS, env });
  const versionMatch = /Python (\d+)\.(\d+)\.(\d+)/.exec(`${version.stdout} ${version.stderr}`);
  if (version.code !== 0 || !versionMatch) {
    throw new VenvError(
      `python.executable ${python} is not a usable Python (${tail(version.stderr || version.stdout, 3) || `exit ${String(version.code)}`}). Install Python 3.10 to 3.13 or set python.executable in the plugin settings.`,
    );
  }
  const [, major, minor] = versionMatch.map(Number) as [number, number, number, number];
  if (major !== 3 || minor < 10 || minor > 13) {
    throw new VenvError(
      `${python} is Python ${versionMatch[0].slice(7)}; the plugin needs Python 3.10 to 3.13. Install one and set python.executable in the plugin settings.`,
    );
  }

  const reasons: string[] = [];
  if (force) reasons.push('python.forceVenvRecreate is on');
  for (const file of ['pyvenv.cfg', 'bin/python3', 'bin/pip3']) {
    if (!(await exists(path.join(venv, file)))) reasons.push(`${file} is missing`);
  }
  if (reasons.length === 0) {
    const system = await run(python, ['-c', SYSTEM_PROBE], { timeoutMs: SHORT_TIMEOUT_MS, env });
    const current = await run(venvPython, ['-c', VENV_PROBE], { timeoutMs: SHORT_TIMEOUT_MS, env });
    if (current.code !== 0 || system.code !== 0 || current.stdout.trim() !== system.stdout.trim()) {
      reasons.push('it was built with another Python');
    }
  }
  if (reasons.length > 0) {
    log.info(`Creating the Python venv in ${venv} (${reasons.join(', ')})`);
    const created = await run(python, ['-m', 'venv', venv, '--clear'], { timeoutMs: VENV_TIMEOUT_MS, env });
    if (created.code !== 0) {
      throw new VenvError(
        `Cannot create the Python venv in ${venv}: ${tail(created.stderr || created.stdout, 5)}. On Debian or Ubuntu install it with: sudo apt-get install python3-venv`,
      );
    }
  }

  const ssl = await run(venvPython, ['-c', SSL_PROBE], { timeoutMs: SHORT_TIMEOUT_MS, env });
  const sslMatch = /OpenSSL (\d+)\.(\d+)\.(\d+)/.exec(ssl.stdout);
  if (!sslMatch) {
    log.warn(`Cannot read the OpenSSL version of ${venvPython} (${ssl.stdout.trim() || 'no output'}); pyatv needs OpenSSL 3.0 or later`);
  } else if (Number(sslMatch[1]) < 3) {
    throw new VenvError(`${venvPython} uses ${sslMatch[0]}; pyatv needs OpenSSL 3.0 or later. Upgrade the system Python and OpenSSL.`);
  }

  const wanted = requirementLines(await readFile(requirementsPath, 'utf8'));
  const freeze = await run(venvPython, ['-m', 'pip', 'freeze'], { timeoutMs: SHORT_TIMEOUT_MS, env });
  const installed = new Set(freeze.code === 0 ? requirementLines(freeze.stdout) : []);
  const missing = wanted.filter((line) => !installed.has(line));
  if (missing.length > 0) {
    log.info(`Installing ${purpose} Python packages (${missing.length} to install or update); this can take a few minutes`);
    const upgrade = await run(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'], { timeoutMs: PIP_UPGRADE_TIMEOUT_MS, env });
    if (upgrade.code !== 0) log.warn(`Upgrading pip failed, continuing with the bundled pip: ${tail(upgrade.stderr, 3)}`);
    const install = await run(venvPython, ['-m', 'pip', 'install', '-r', requirementsPath], { timeoutMs: PIP_INSTALL_TIMEOUT_MS, env });
    if (install.code !== 0) {
      throw new VenvError(
        `Installing ${purpose} Python packages failed: ${tail(install.stderr || install.stdout, 8)}. Check the network access to PyPI, then restart Homebridge (or set python.forceVenvRecreate).`,
      );
    }
  }
  return { python: venvPython };
}

/** Spawns without a shell, collecting output; kills the process after `timeoutMs`. */
export const runCommand: Run = (cmd, args, options) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: `Cannot run ${cmd}: ${(error as Error).message}` });
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ code: null, stdout, stderr: `${stderr}\n${cmd} timed out after ${options.timeoutMs}ms` });
    }, options.timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => done({ code: null, stdout, stderr: `Cannot run ${cmd}: ${error.message}` }));
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
