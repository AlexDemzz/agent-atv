#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { parseArgv, type ParsedArgs } from './args.js';
import { COMMANDS, findCommand } from './commands/index.js';
import { Context, type Io } from './context.js';
import { AtvError, usageError } from './errors.js';
import { EXIT, exitCodeFor } from './exit-codes.js';
import { formatErrorText } from './output.js';
import { VERSION } from './version.js';

function helpText(): string {
  const width = Math.max(...COMMANDS.map((command) => command.usage.length));
  const commands = COMMANDS.map((command) => `  ${command.usage.padEnd(width)}  ${command.summary}`);
  return [
    `agent-atv ${VERSION}: drive an Apple TV through the homebridge-agent-atv API`,
    '',
    'Usage: agent-atv <command> [args] [flags]',
    '',
    'Commands:',
    ...commands,
    '',
    'Actions print only their own line. --settle also waits for the focus to settle and prints a Focus: line.',
    '',
    'Global flags:',
    '  --url <url>              API base, e.g. http://192.168.1.20:8787 (env AGENT_ATV_URL)',
    '  --token <t>              API token (env AGENT_ATV_TOKEN; prefer env or config set token -)',
    '  -d, --device <id|name>   device, default "default" (env AGENT_ATV_DEVICE)',
    '  --json                   machine-readable output',
    '  --timeout <ms>           HTTP timeout, default 30000 (env AGENT_ATV_TIMEOUT_MS)',
    '  -h, --help               show this help',
    '  -V, --version            print the version',
    '',
    'Agents: load the usage guide first with: agent-atv skills get core',
    '',
  ].join('\n');
}

function reportError(error: unknown, json: boolean, io: Io): number {
  const atvError =
    error instanceof AtvError
      ? error
      : new AtvError('INTERNAL', error instanceof Error ? error.message : String(error), {
          details: { exception: error instanceof Error ? error.name : typeof error },
        });
  if (json) io.stdout(`${JSON.stringify(atvError.toBody())}\n`);
  else io.stderr(formatErrorText(atvError));
  return exitCodeFor(atvError);
}

export async function main(argv: string[], io: Io): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgv(argv, (name) => findCommand(name)?.flags);
  } catch (error) {
    return reportError(error, argv.includes('--json'), io);
  }
  const json = args.flags.has('json');

  if (args.flags.has('version')) {
    io.stdout(`${VERSION}\n`);
    return EXIT.ok;
  }
  if (args.flags.has('help') || args.command === 'help') {
    io.stdout(helpText());
    return EXIT.ok;
  }
  if (args.command === undefined) {
    io.stderr(helpText());
    return EXIT.usage;
  }

  const command = findCommand(args.command);
  if (!command) {
    return reportError(usageError(`Unknown command "${args.command}"`), json, io);
  }

  const ctx = new Context(args, io, { ownTimeoutFlag: command.ownTimeoutFlag === true });
  try {
    return (await command.run(ctx)) ?? EXIT.ok;
  } catch (error) {
    return reportError(error, json, io);
  }
}

const io: Io = {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  stdin: process.stdin,
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  async prompt(question) {
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await readline.question(question);
    } finally {
      readline.close();
    }
  },
};

main(process.argv.slice(2), io).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`error: ${error instanceof Error ? error.stack : String(error)} (INTERNAL)\n`);
    process.exitCode = EXIT.failed;
  },
);
