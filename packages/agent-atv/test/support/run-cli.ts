import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI_PATH = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface Sandbox {
  root: string;
  home: string;
  configHome: string;
  cacheHome: string;
  tmp: string;
  env: Record<string, string>;
  run(args: string[], options?: { env?: Record<string, string | undefined>; stdin?: string }): Promise<CliResult>;
  cleanup(): void;
}

export function createSandbox(baseEnv: Record<string, string> = {}): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'agent-atv-cli-test-'));
  const home = join(root, 'home');
  const configHome = join(root, 'config');
  const cacheHome = join(root, 'cache');
  const tmp = join(root, 'tmp');

  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('AGENT_ATV_') && !key.startsWith('XDG_')) inherited[key] = value;
  }
  const env: Record<string, string> = {
    ...inherited,
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    XDG_CACHE_HOME: cacheHome,
    TMPDIR: tmp,
    ...baseEnv,
  };

  return {
    root,
    home,
    configHome,
    cacheHome,
    tmp,
    env,
    run(args, options = {}) {
      const childEnv: Record<string, string> = { ...env };
      for (const [key, value] of Object.entries(options.env ?? {})) {
        if (value === undefined) delete childEnv[key];
        else childEnv[key] = value;
      }
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [CLI_PATH, ...args], { env: childEnv, cwd: root });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(options.stdin ?? '');
      });
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
