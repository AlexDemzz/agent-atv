import { readFileSync } from 'node:fs';

export const PACKAGE_ROOT = new URL('../', import.meta.url);

export const VERSION: string = (
  JSON.parse(readFileSync(new URL('package.json', PACKAGE_ROOT), 'utf8')) as { version: string }
).version;
