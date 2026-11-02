import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSandbox, type Sandbox } from './support/run-cli.js';

const CORE = fileURLToPath(new URL('../skills/core/', import.meta.url));
let sandbox: Sandbox;

beforeEach(() => {
  sandbox = createSandbox();
});

afterEach(() => {
  sandbox.cleanup();
});

function bundled(path: string): string {
  return readFileSync(`${CORE}${path}`, 'utf8');
}

describe('skills', () => {
  it('lists the core skill with its frontmatter description, without any config', async () => {
    const result = await sandbox.run(['skills', 'list']);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^core {2}\S.*Apple TV.*\n$/);
  });

  it('prints SKILL.md for get core', async () => {
    const result = await sandbox.run(['skills', 'get', 'core']);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(bundled('SKILL.md'));
  });

  it('appends references then templates with --full', async () => {
    const result = await sandbox.run(['skills', 'get', 'core', '--full']);

    const references = readdirSync(`${CORE}references`).sort();
    const templates = readdirSync(`${CORE}templates`).sort();
    expect(references).toEqual(['commands.md', 'trust-boundaries.md']);
    expect(templates).toEqual(['search-and-play.sh']);
    const expected =
      bundled('SKILL.md') +
      [...references.map((file) => `references/${file}`), ...templates.map((file) => `templates/${file}`)]
        .map((path) => `\n\n---\n# ${path}\n\n${bundled(path)}`)
        .join('');
    expect(result.stdout).toBe(expected);
  });

  it('rejects an unknown skill with exit 2', async () => {
    const result = await sandbox.run(['skills', 'get', 'nope']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('core');
  });
});
