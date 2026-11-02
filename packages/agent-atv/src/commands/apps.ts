import { booleanFlag, stringFlag } from '../args.js';
import { devicePath } from '../client.js';
import type { Command } from '../context.js';
import type { App } from '../output.js';

export const apps: Command = {
  name: 'apps',
  usage: 'apps',
  summary: 'list installed apps (bundle id and name)',
  flags: [{ name: 'refresh' }, { name: 'filter', value: 'required' }],
  async run(ctx) {
    const query = booleanFlag(ctx.args, 'refresh') ? '?refresh=1' : '';
    const response = await ctx.client().json<{ apps: App[] }>('GET', devicePath(ctx.device(), `/apps${query}`));
    const filter = stringFlag(ctx.args, 'filter')?.toLowerCase();
    const list = response.apps
      .filter((app) => !filter || app.name.toLowerCase().includes(filter) || app.bundleId.toLowerCase().includes(filter))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    if (ctx.json) return ctx.printJson({ ...response, apps: list });
    for (const app of list) ctx.print(`${app.bundleId}  ${app.name}`);
  },
};
