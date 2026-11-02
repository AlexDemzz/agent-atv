import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../logger';
import { writeFileAtomic } from '../fs-util';

export const MIN_TOKEN_LENGTH = 32;

/** Resolves the API token (DESIGN.md §3.1). Returns null when the API must not start. */
export async function resolveToken(options: {
  configured: string;
  pluginDir: string;
  log: Logger;
}): Promise<string | null> {
  const { configured, pluginDir, log } = options;
  if (configured !== '') {
    if (configured.length < MIN_TOKEN_LENGTH) {
      log.error(
        `api.token is set but shorter than ${MIN_TOKEN_LENGTH} characters, so the HTTP API is off. Use a token of at least 32 characters, or clear api.token to use the generated one.`,
      );
      return null;
    }
    return configured;
  }

  const tokenPath = path.join(pluginDir, 'token');
  try {
    const stored = (await readFile(tokenPath, 'utf8')).trim();
    if (stored.length >= MIN_TOKEN_LENGTH) {
      log.info(`API token loaded from ${tokenPath} (…${stored.slice(-4)})`);
      return stored;
    }
    log.warn(`${tokenPath} holds an invalid token; generating a new one`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.error(`Cannot read ${tokenPath}: ${(error as Error).message}. The HTTP API is off.`);
      return null;
    }
  }

  const token = randomBytes(32).toString('base64url');
  await writeFileAtomic(tokenPath, `${token}\n`);
  log.warn(`Generated a new agent-atv API token in ${tokenPath} (mode 0600). Copy it from the plugin settings UI.`);
  return token;
}

export function isAuthorized(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  const given = Buffer.from(match[1]!.trim(), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
