import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createAgentAtvCore, readPluginVersion } from './core';
import { errorMessage, type Logger } from './logger';

const USAGE = 'usage: node dist/standalone.js --config <file.json> --storage <dir>';

function main(): void {
  let values: { config?: string; storage?: string };
  try {
    ({ values } = parseArgs({ options: { config: { type: 'string' }, storage: { type: 'string' } } }));
  } catch (error) {
    console.error(`${errorMessage(error)}\n${USAGE}`);
    process.exit(2);
  }
  if (!values.config || !values.storage) {
    console.error(USAGE);
    process.exit(2);
  }

  let config: unknown;
  try {
    config = JSON.parse(readFileSync(values.config, 'utf8'));
  } catch (error) {
    console.error(`Cannot read ${values.config}: ${errorMessage(error)}`);
    process.exit(2);
  }

  const line = (level: string) => (message: string) => console.log(`[${new Date().toISOString()}] ${level} ${message}`);
  const log: Logger = { debug: line('debug'), info: line('info'), warn: line('warn'), error: line('error') };
  const core = createAgentAtvCore({
    config,
    storagePath: path.resolve(values.storage),
    log,
    pluginVersion: readPluginVersion(),
    onListening: (address) => {
      const host = address.host.includes(':') ? `[${address.host}]` : address.host;
      console.log(`listening on http://${host}:${address.port}`);
    },
  });

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    core.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        log.error(`stop failed: ${errorMessage(error)}`);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  core.start().then(
    () => {
      if (core.address()) return;
      log.error('The HTTP API did not start; see the errors above');
      stop();
    },
    (error: unknown) => {
      log.error(`start failed: ${errorMessage(error)}`);
      process.exit(1);
    },
  );
}

main();
