import { type ConfigFile, configPath, maskToken, readConfigFile, writeConfigFile } from '../config.js';
import type { Command, Context } from '../context.js';
import { usageError } from '../errors.js';
import { readAll } from '../stdin.js';

const EXAMPLES: Record<Key, string> = { url: 'http://<homebridge-host>:8787', token: '-', device: '"Living Room"' };

const KEYS = ['url', 'device', 'token'] as const;
type Key = (typeof KEYS)[number];

function show(ctx: Context): void {
  const config = ctx.config();
  const token = config.token.value === undefined ? null : maskToken(config.token.value);
  if (ctx.json) {
    ctx.printJson({
      path: config.path,
      url: { value: config.url.value ?? null, source: config.url.source },
      device: config.device,
      token: { value: token, source: config.token.source },
      timeoutMs: config.timeoutMs,
    });
    return;
  }
  ctx.print(`url: ${config.url.value ?? '(not set)'} (${config.url.source})`);
  ctx.print(`device: ${config.device.value} (${config.device.source})`);
  ctx.print(`token: ${maskToken(config.token.value)} (${config.token.source})`);
  ctx.print(`timeout: ${config.timeoutMs.value}ms (${config.timeoutMs.source})`);
  ctx.print(`file: ${config.path}`);
}

async function set(ctx: Context, key: string | undefined, value: string | undefined): Promise<void> {
  if (!KEYS.includes(key as Key)) {
    throw usageError(`config set needs one of: ${KEYS.join(', ')}`, 'Example: agent-atv config set url http://192.168.1.20:8787');
  }
  if (value === undefined) throw usageError(`config set ${key} needs a value`, `e.g. agent-atv config set ${key} ${EXAMPLES[key as Key]}`);

  let stored = value;
  if (key === 'url') {
    if (!/^https?:\/\/[^/\s]+/.test(value)) {
      throw usageError(`"${value}" is not an http(s) URL`, 'Example: agent-atv config set url http://192.168.1.20:8787');
    }
  } else if (key === 'token') {
    if (value === '-') {
      if (ctx.io.stdin.isTTY) ctx.warn('Paste the token, then press Enter and Ctrl-D:');
      stored = (await readAll(ctx.io.stdin)).trim();
      if (stored === '') throw usageError('No token on stdin', 'Pipe it in: pbpaste | agent-atv config set token -');
    } else {
      ctx.warn('warning: a token on the command line is visible in shell history; prefer: agent-atv config set token -');
    }
  }

  const path = ctx.config().path;
  const file: ConfigFile = { ...readConfigFile(path, () => {}), [key as Key]: stored };
  writeConfigFile(path, file);
  const shown = key === 'token' ? maskToken(stored) : stored;
  if (ctx.json) ctx.printJson({ ok: true, key, value: shown, path });
  else ctx.print(`${key}: ${shown} (saved to ${path})`);
}

export const config: Command = {
  name: 'config',
  usage: 'config show | set <url|device|token> <value> | path',
  summary: 'show or change the CLI configuration',
  async run(ctx) {
    const [sub, key, value] = ctx.args.positionals;
    if (sub === 'show') return show(ctx);
    if (sub === 'set') return set(ctx, key, value);
    if (sub === 'path') {
      const path = configPath(ctx.io.env);
      if (ctx.json) ctx.printJson({ path });
      else ctx.print(path);
      return;
    }
    throw usageError('Usage: agent-atv config show | set <url|device|token> <value> | path');
  },
};
