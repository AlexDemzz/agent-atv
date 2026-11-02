import { usageError } from './errors.js';

export interface FlagSpec {
  name: string;
  short?: string;
  /** `required` consumes the next token, `optional` consumes it only when it isn't a flag. */
  value?: 'none' | 'required' | 'optional';
}

export type FlagValue = string | true;

export interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  flags: Map<string, FlagValue>;
}

export const GLOBAL_FLAGS: FlagSpec[] = [
  { name: 'url', value: 'required' },
  { name: 'token', value: 'required' },
  { name: 'device', short: 'd', value: 'required' },
  { name: 'json' },
  { name: 'timeout', value: 'required' },
  { name: 'help', short: 'h' },
  { name: 'version', short: 'V' },
];

const NEGATIVE_NUMBER = /^-\d/;

function isFlagToken(token: string): boolean {
  return token.startsWith('-') && token !== '-' && !NEGATIVE_NUMBER.test(token);
}

function findSpec(specs: FlagSpec[], token: string): { spec: FlagSpec; inline: string | undefined } | undefined {
  if (token.startsWith('--')) {
    const eq = token.indexOf('=');
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    const inline = eq === -1 ? undefined : token.slice(eq + 1);
    const spec = specs.find((candidate) => candidate.name === name);
    return spec ? { spec, inline } : undefined;
  }
  const short = token.slice(1, 2);
  const rest = token.slice(2);
  const spec = specs.find((candidate) => candidate.short === short);
  if (!spec) return undefined;
  return { spec, inline: rest === '' ? undefined : rest.replace(/^=/, '') };
}

function consume(
  argv: string[],
  index: number,
  specs: FlagSpec[],
  flags: Map<string, FlagValue>,
): number {
  const token = argv[index] as string;
  const found = findSpec(specs, token);
  if (!found) throw usageError(`Unknown option ${token}`);
  const { spec, inline } = found;
  const kind = spec.value ?? 'none';
  if (kind === 'none') {
    if (inline !== undefined) throw usageError(`Option --${spec.name} takes no value`);
    flags.set(spec.name, true);
    return index + 1;
  }
  if (inline !== undefined) {
    flags.set(spec.name, inline);
    return index + 1;
  }
  const next = argv[index + 1];
  if (kind === 'required') {
    if (next === undefined) throw usageError(`Option --${spec.name} needs a value`);
    flags.set(spec.name, next);
    return index + 2;
  }
  if (next !== undefined && !isFlagToken(next)) {
    flags.set(spec.name, next);
    return index + 2;
  }
  flags.set(spec.name, true);
  return index + 1;
}

/**
 * Global flags may appear anywhere. Flags after the command also accept that command's own flags,
 * which win over a global flag of the same name (e.g. `wait --timeout`).
 */
export function parseArgv(argv: string[], commandFlags: (command: string) => FlagSpec[] | undefined): ParsedArgs {
  const flags = new Map<string, FlagValue>();
  const positionals: string[] = [];
  let command: string | undefined;
  let specs = GLOBAL_FLAGS;
  let index = 0;

  while (index < argv.length) {
    const token = argv[index] as string;
    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (isFlagToken(token)) {
      index = consume(argv, index, specs, flags);
      continue;
    }
    if (command === undefined) {
      command = token;
      const own = commandFlags(token) ?? [];
      specs = [...own, ...GLOBAL_FLAGS.filter((global) => !own.some((spec) => spec.name === global.name))];
    } else {
      positionals.push(token);
    }
    index += 1;
  }

  return { command, positionals, flags };
}

export function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  if (value === true) throw usageError(`Option --${name} needs a value`);
  return value;
}

export function booleanFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}

export function integerFlag(args: ParsedArgs, name: string, min: number, max: number): number | undefined {
  const raw = stringFlag(args, name);
  if (raw === undefined) return undefined;
  return parseInteger(raw, `--${name}`, min, max);
}

export function parseInteger(raw: string, label: string, min: number, max: number): number {
  if (!/^-?\d+$/.test(raw)) throw usageError(`${label} must be an integer, got "${raw}"`);
  const value = Number(raw);
  if (value < min || value > max) throw usageError(`${label} must be between ${min} and ${max}, got ${value}`);
  return value;
}
