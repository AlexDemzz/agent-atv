import type { FlagSpec, ParsedArgs } from './args.js';
import { ApiClient, normalizeBaseUrl } from './client.js';
import { type ResolvedConfig, resolveConfig } from './config.js';
import { AtvError } from './errors.js';

export interface Io {
  env: NodeJS.ProcessEnv;
  stdout(text: string): void;
  stderr(text: string): void;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  interactive: boolean;
  prompt(question: string): Promise<string>;
}

export class Context {
  readonly json: boolean;
  private resolved: ResolvedConfig | undefined;

  constructor(
    readonly args: ParsedArgs,
    readonly io: Io,
    private readonly options: { ownTimeoutFlag: boolean },
  ) {
    this.json = args.flags.has('json');
  }

  print(line: string): void {
    this.io.stdout(`${line}\n`);
  }

  printJson(body: unknown): void {
    this.io.stdout(`${JSON.stringify(body)}\n`);
  }

  warn(message: string): void {
    this.io.stderr(`${message}\n`);
  }

  config(): ResolvedConfig {
    if (!this.resolved) {
      const args = this.options.ownTimeoutFlag ? withoutFlag(this.args, 'timeout') : this.args;
      this.resolved = resolveConfig(args, this.io.env, (message) => this.warn(message));
    }
    return this.resolved;
  }

  device(): string {
    return this.config().device.value;
  }

  client(): ApiClient {
    const config = this.config();
    if (config.url.value === undefined) {
      throw new AtvError('CONFIG_MISSING', 'No API URL configured', {
        hint: 'run agent-atv config set url http://<homebridge-host>:8787',
      });
    }
    if (config.token.source === 'flag' && !this.tokenWarned) {
      this.tokenWarned = true;
      this.warn('warning: --token is visible in shell history; prefer AGENT_ATV_TOKEN or agent-atv config set token -');
    }
    return new ApiClient(normalizeBaseUrl(config.url.value), config.token.value, config.timeoutMs.value);
  }

  private tokenWarned = false;
}

function withoutFlag(args: ParsedArgs, name: string): ParsedArgs {
  const flags = new Map(args.flags);
  flags.delete(name);
  return { ...args, flags };
}

export interface Command {
  name: string;
  usage: string;
  summary: string;
  flags?: FlagSpec[];
  /** The command defines its own --timeout, so the global HTTP timeout flag doesn't apply. */
  ownTimeoutFlag?: boolean;
  /** Resolves to the exit code, or undefined for success. */
  run(ctx: Context): Promise<number | void>;
}
