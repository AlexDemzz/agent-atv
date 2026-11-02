import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { type ParsedArgs, parseInteger, stringFlag } from './args.js';
import { AtvError } from './errors.js';

export type Source = 'flag' | 'env' | 'file' | 'default';

export interface Resolved<T> {
  value: T;
  source: Source;
}

export interface ConfigFile {
  url?: string;
  token?: string;
  device?: string;
}

export interface ResolvedConfig {
  path: string;
  url: Resolved<string | undefined>;
  token: Resolved<string | undefined>;
  device: Resolved<string>;
  timeoutMs: Resolved<number>;
}

export const DEFAULT_TIMEOUT_MS = 30000;

type Env = NodeJS.ProcessEnv;

export function configPath(env: Env): string {
  if (env.AGENT_ATV_CONFIG) return env.AGENT_ATV_CONFIG;
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
  return join(base, 'agent-atv', 'config.json');
}

export function cacheDir(env: Env): string {
  const base = env.XDG_CACHE_HOME || join(env.HOME || homedir(), '.cache');
  return join(base, 'agent-atv');
}

export function readConfigFile(path: string, warn: (message: string) => void): ConfigFile {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new AtvError('USAGE', `Cannot read config file ${path}: ${(error as Error).message}`, {
      hint: `Check the file permissions, or point AGENT_ATV_CONFIG at another file.`,
    });
  }
  if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) {
    warn(`warning: ${path} is readable by other users; run: chmod 600 ${path}`);
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
    const file = parsed as Record<string, unknown>;
    const result: ConfigFile = {};
    for (const key of ['url', 'token', 'device'] as const) {
      if (typeof file[key] === 'string') result[key] = file[key];
    }
    return result;
  } catch (error) {
    throw new AtvError('USAGE', `Config file ${path} is not valid JSON: ${(error as Error).message}`, {
      hint: `Fix or delete ${path}, then run agent-atv config set url http://<homebridge-host>:8787`,
    });
  }
}

export function writeConfigFile(path: string, config: ConfigFile): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

function pick<T>(flag: T | undefined, env: T | undefined, file: T | undefined, fallback: T): Resolved<T> {
  if (flag !== undefined) return { value: flag, source: 'flag' };
  if (env !== undefined) return { value: env, source: 'env' };
  if (file !== undefined) return { value: file, source: 'file' };
  return { value: fallback, source: 'default' };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

export function resolveConfig(args: ParsedArgs, env: Env, warn: (message: string) => void): ResolvedConfig {
  const path = configPath(env);
  const file = readConfigFile(path, warn);
  const envTimeout = nonEmpty(env.AGENT_ATV_TIMEOUT_MS);
  const flagTimeout = stringFlag(args, 'timeout');
  const timeout = pick(flagTimeout, envTimeout, undefined, String(DEFAULT_TIMEOUT_MS));
  return {
    path,
    url: pick(nonEmpty(stringFlag(args, 'url')), nonEmpty(env.AGENT_ATV_URL), nonEmpty(file.url), undefined),
    token: pick(nonEmpty(stringFlag(args, 'token')), nonEmpty(env.AGENT_ATV_TOKEN), nonEmpty(file.token), undefined),
    device: pick(nonEmpty(stringFlag(args, 'device')), nonEmpty(env.AGENT_ATV_DEVICE), nonEmpty(file.device), 'default'),
    timeoutMs: {
      value: parseInteger(timeout.value, timeout.source === 'env' ? 'AGENT_ATV_TIMEOUT_MS' : '--timeout', 1, 3_600_000),
      source: timeout.source,
    },
  };
}

export function maskToken(token: string | undefined): string {
  return token === undefined ? '(not set)' : `…${token.slice(-4)}`;
}
