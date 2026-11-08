import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { Run, RunResult } from '../../src/python/venv';

export interface RecordedRun {
  cmd: string;
  args: string[];
  timeoutMs: number;
}

const ok = (stdout = '', stderr = ''): RunResult => ({ code: 0, stdout, stderr });
const fail = (stderr: string, code = 1): RunResult => ({ code, stdout: '', stderr });

/**
 * A command runner that behaves like a system Python plus the venv it creates under `<pluginDir>/.venv`.
 * It writes the venv's marker files on disk, as `python -m venv` would.
 */
export class FakePython {
  readonly calls: RecordedRun[] = [];
  systemCommand = 'python3';
  systemExecutable = '/usr/bin/python3.11';
  systemVersion = '3.11.2';
  versionOutput: string | null = null;
  openssl = 'OpenSSL 3.0.15 3 Sep 2024';
  venvCreateError: string | null = null;
  pipUpgradeError: string | null = null;
  pipInstallError: string | null = null;
  /** `pip freeze` lines of the venv. */
  installed: string[] = [];
  venvBaseExecutable = '';
  venvVersion = '';
  sysPlatform = 'linux';
  pythonImplementation = 'CPython';
  markerProbeFails = false;

  constructor(
    readonly pluginDir: string,
    readonly venvName = '.venv',
  ) {}

  get venvDir(): string {
    return path.join(this.pluginDir, this.venvName);
  }

  get venvPython(): string {
    return path.join(this.venvDir, 'bin', 'python3');
  }

  /** Lays down a venv made by an earlier run, with `installed` packages. */
  createExistingVenv(installed: string[]): void {
    this.writeVenv();
    this.installed = installed;
  }

  commands(): string[] {
    return this.calls.map((c) => [c.cmd, ...c.args].join(' '));
  }

  readonly run: Run = async (cmd, args, options) => {
    this.calls.push({ cmd, args: [...args], timeoutMs: options.timeoutMs });
    const joined = args.join(' ');
    if (cmd === this.systemCommand) {
      if (joined === '--version') return ok(this.versionOutput ?? `Python ${this.systemVersion}\n`);
      if (args[0] === '-m' && args[1] === 'venv') {
        if (this.venvCreateError) return fail(this.venvCreateError);
        rmSync(this.venvDir, { recursive: true, force: true });
        this.writeVenv();
        this.installed = ['pip==24.0'];
        return ok();
      }
      if (args[0] === '-c' && joined.includes('sys.executable')) {
        return ok(`${this.systemExecutable}\n${this.systemVersion}\n`);
      }
    }
    if (cmd === this.venvPython && existsSync(this.venvPython)) {
      if (args[0] === '-c' && joined.includes('_base_executable')) return ok(`${this.venvBaseExecutable}\n${this.venvVersion}\n`);
      if (args[0] === '-c' && joined.includes('OPENSSL_VERSION')) return ok(`${this.openssl}\n`);
      if (args[0] === '-c' && joined.includes('python_implementation')) {
        if (this.markerProbeFails) return fail('Traceback (most recent call last): ...');
        return ok(`${this.venvVersion}\n${this.sysPlatform}\n${this.pythonImplementation}\n${this.pythonImplementation.toLowerCase()}\n`);
      }
      if (joined === '-m pip freeze') return ok(`${this.installed.join('\n')}\n`);
      if (joined.startsWith('-m pip install --upgrade pip')) return this.pipUpgradeError ? fail(this.pipUpgradeError) : ok();
      if (joined.startsWith('-m pip install -r ')) {
        if (this.pipInstallError) return fail(this.pipInstallError);
        this.installed = ['pip==25.0', ...this.requirementsInstalled];
        return ok();
      }
    }
    return fail(`fake python: unexpected command ${cmd} ${joined}`, 127);
  };

  /** What `pip install -r` leaves installed; set by the test to the requirements it wrote. */
  requirementsInstalled: string[] = [];

  private writeVenv(): void {
    mkdirSync(path.join(this.venvDir, 'bin'), { recursive: true });
    writeFileSync(path.join(this.venvDir, 'pyvenv.cfg'), `home = ${path.dirname(this.systemExecutable)}\n`);
    writeFileSync(this.venvPython, '');
    writeFileSync(path.join(this.venvDir, 'bin', 'pip3'), '');
    this.venvBaseExecutable = this.systemExecutable;
    this.venvVersion = this.systemVersion;
  }
}
