import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { booleanFlag } from './args.js';
import type { Command } from './context.js';
import { usageError } from './errors.js';
import { PACKAGE_ROOT } from './version.js';

const SKILLS_DIR = fileURLToPath(new URL('skills/', PACKAGE_ROOT));
const EXTRA_DIRS = ['references', 'templates'];

interface Skill {
  name: string;
  description: string;
}

function frontmatterField(markdown: string, field: string): string {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(markdown)?.[1] ?? '';
  const line = frontmatter.split('\n').find((candidate) => candidate.startsWith(`${field}:`));
  return line ? line.slice(field.length + 1).trim().replace(/^(['"])(.*)\1$/, '$2') : '';
}

function listSkills(): Skill[] {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(SKILLS_DIR, entry.name, 'SKILL.md')))
    .map((entry) => ({
      name: entry.name,
      description: frontmatterField(readFileSync(join(SKILLS_DIR, entry.name, 'SKILL.md'), 'utf8'), 'description'),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function skillContent(name: string, full: boolean): string {
  const skills = listSkills();
  if (!skills.some((skill) => skill.name === name)) {
    throw usageError(`Unknown skill "${name}"`, `Available skills: ${skills.map((skill) => skill.name).join(', ')}`);
  }
  const dir = join(SKILLS_DIR, name);
  let content = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  if (!full) return content;
  for (const sub of EXTRA_DIRS) {
    if (!existsSync(join(dir, sub))) continue;
    for (const file of readdirSync(join(dir, sub)).sort()) {
      content += `\n\n---\n# ${sub}/${file}\n\n${readFileSync(join(dir, sub, file), 'utf8')}`;
    }
  }
  return content;
}

export const skills: Command = {
  name: 'skills',
  usage: 'skills list | get <name> [--full]',
  summary: 'print the bundled agent skill (start with: skills get core)',
  flags: [{ name: 'full' }],
  async run(ctx) {
    const [sub, name, ...extra] = ctx.args.positionals;
    if (sub === 'list' && name === undefined) {
      const list = listSkills();
      if (ctx.json) return ctx.printJson({ skills: list });
      for (const skill of list) ctx.print(`${skill.name}  ${skill.description}`);
      return;
    }
    if (sub === 'get' && name !== undefined && extra.length === 0) {
      const content = skillContent(name, booleanFlag(ctx.args, 'full'));
      if (ctx.json) return ctx.printJson({ name, content });
      ctx.io.stdout(content);
      return;
    }
    throw usageError('Usage: agent-atv skills list | skills get <name> [--full]', 'Start with: agent-atv skills get core');
  },
};
