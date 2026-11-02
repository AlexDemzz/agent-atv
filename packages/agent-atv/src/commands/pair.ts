import { booleanFlag, stringFlag } from '../args.js';
import { devicePath } from '../client.js';
import type { Command, Context } from '../context.js';
import { usageError } from '../errors.js';

interface PairStep {
  pairingId: string;
  protocol: string;
  step: number;
  steps: number;
  message: string;
}

type PinResponse =
  | ({ status: 'next' } & PairStep)
  | { status: 'done'; device: { id: string; name: string }; warning?: string };

const PIN = /^\d{4,8}$/;

function checkPin(pin: string): string {
  if (!PIN.test(pin)) throw usageError('The PIN must be the digits shown on the TV', 'type the PIN exactly as the TV shows it');
  return pin;
}

function instruction(step: PairStep): string {
  return (
    `pairing ${step.pairingId} started (step ${step.step}/${step.steps}, ${step.protocol}): ` +
    `run agent-atv pair --pairing ${step.pairingId} --pin <PIN>`
  );
}

/** One PIN can chain pair.pin, pair.verify, pair.begin and a reconnect on the plugin, 30 s each at worst. */
const PAIRING_TIMEOUT_MS = 120_000;

async function submitPin(ctx: Context, pairingId: string, pin: string): Promise<PinResponse> {
  const client = ctx.client();
  return client.json<PinResponse>('POST', `/pairings/${encodeURIComponent(pairingId)}/pin`, {
    body: { pin },
    timeoutMs: Math.max(client.timeoutMs, PAIRING_TIMEOUT_MS),
  });
}

function printResult(ctx: Context, response: PinResponse): void {
  if (ctx.json) return ctx.printJson(response);
  if (response.status === 'done') {
    ctx.print(`paired ${response.device.name} (${response.device.id})`);
    if (response.warning) ctx.warn(`warning: ${response.warning}`);
  } else {
    ctx.print(instruction(response));
  }
}

async function interactive(ctx: Context, first: PairStep): Promise<void> {
  let step: PairStep = first;
  for (;;) {
    const pin = (await ctx.io.prompt(`${step.message} (step ${step.step}/${step.steps}, ${step.protocol}): `)).trim();
    if (!PIN.test(pin)) {
      await ctx.client().json('DELETE', `/pairings/${encodeURIComponent(step.pairingId)}`).catch(() => undefined);
      checkPin(pin);
    }
    const response = await submitPin(ctx, step.pairingId, pin);
    if (response.status === 'done') return printResult(ctx, response);
    step = response;
  }
}

export const pair: Command = {
  name: 'pair',
  usage: 'pair [device] [--screen] | --pairing <id> --pin <PIN> | --cancel <id>',
  summary: 'pair an Apple TV (PIN shown on the TV); --screen pairs only screen reading',
  flags: [
    { name: 'no-input' },
    { name: 'screen' },
    { name: 'pairing', value: 'required' },
    { name: 'pin', value: 'required' },
    { name: 'cancel', value: 'required' },
  ],
  async run(ctx) {
    const cancel = stringFlag(ctx.args, 'cancel');
    if (cancel !== undefined) {
      const response = await ctx.client().json<{ ok: true }>('DELETE', `/pairings/${encodeURIComponent(cancel)}`);
      if (ctx.json) return ctx.printJson(response);
      return ctx.print(`cancelled ${cancel}`);
    }

    const pairingId = stringFlag(ctx.args, 'pairing');
    const pin = stringFlag(ctx.args, 'pin');
    if (pin !== undefined || pairingId !== undefined) {
      if (pin === undefined || pairingId === undefined) {
        throw usageError('--pairing and --pin go together', 'Example: agent-atv pair --pairing p-0123456789ab --pin 1234');
      }
      return printResult(ctx, await submitPin(ctx, pairingId, checkPin(pin)));
    }

    const [device = ctx.device(), ...extra] = ctx.args.positionals;
    if (extra.length > 0) throw usageError('pair takes at most one device', 'e.g. agent-atv pair "Living Room"');
    const client = ctx.client();
    const started = await client.json<PairStep>('POST', devicePath(device, '/pair'), {
      body: booleanFlag(ctx.args, 'screen') ? { protocol: 'remotepairing' } : {},
      timeoutMs: Math.max(client.timeoutMs, PAIRING_TIMEOUT_MS),
    });
    if (ctx.io.interactive && !ctx.json && !booleanFlag(ctx.args, 'no-input')) return interactive(ctx, started);
    if (ctx.json) return ctx.printJson(started);
    ctx.print(instruction(started));
  },
};

export const unpair: Command = {
  name: 'unpair',
  usage: 'unpair <device>',
  summary: 'forget a pairing (asks for confirmation; --yes without a TTY)',
  flags: [{ name: 'yes' }],
  async run(ctx) {
    const [device, ...extra] = ctx.args.positionals;
    if (device === undefined || extra.length > 0) throw usageError('unpair needs exactly one device', 'Example: agent-atv unpair "Living Room" --yes');
    if (!booleanFlag(ctx.args, 'yes')) {
      if (!ctx.io.interactive) throw usageError('unpair needs --yes when not run on a TTY', `Run: agent-atv unpair ${JSON.stringify(device)} --yes`);
      const answer = (await ctx.io.prompt('Type the device name to confirm: ')).trim();
      if (answer.toLowerCase() !== device.toLowerCase()) throw usageError('Confirmation did not match; nothing was changed', 'type the device name exactly, or pass --yes');
    }
    const response = await ctx.client().json<{ ok: true }>('DELETE', devicePath(device, '/pairing'));
    if (ctx.json) return ctx.printJson(response);
    ctx.print(`unpaired ${device}`);
  },
};
