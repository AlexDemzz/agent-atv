import type { Command } from '../context.js';

interface DeviceSummary {
  id: string;
  name: string;
  address: string | null;
  version: string | null;
  paired: boolean;
  connection: string;
}

interface ScanDevice {
  id: string;
  name: string;
  address: string | null;
  os: string | null;
  version: string | null;
  paired: boolean;
}

function columns(values: (string | null | undefined)[]): string {
  return values.map((value) => (value === null || value === undefined || value === '' ? '-' : value)).join('  ');
}

function osVersion(os: string | null, version: string | null): string | null {
  return version === null ? os : `${os ?? 'tvOS'} ${version}`;
}

export const devices: Command = {
  name: 'devices',
  usage: 'devices',
  summary: 'list known Apple TVs with connection and pairing status',
  async run(ctx) {
    const response = await ctx.client().json<{ devices: DeviceSummary[] }>('GET', '/devices');
    if (ctx.json) return ctx.printJson(response);
    for (const device of response.devices) {
      ctx.print(
        columns([device.id, device.name, device.connection, device.paired ? 'paired' : 'unpaired', osVersion('tvOS', device.version), device.address]),
      );
    }
  },
};

export const scan: Command = {
  name: 'scan',
  usage: 'scan',
  summary: 'discover Apple TVs on the network',
  async run(ctx) {
    const client = ctx.client();
    const response = await client.json<{ devices: ScanDevice[] }>('POST', '/scan', {
      body: {},
      timeoutMs: Math.max(client.timeoutMs, 20000),
    });
    if (ctx.json) return ctx.printJson(response);
    for (const device of response.devices) {
      ctx.print(columns([device.id, device.name, device.paired ? 'paired' : 'unpaired', osVersion(device.os, device.version), device.address]));
    }
  },
};
