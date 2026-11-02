import { devicePath } from '../client.js';
import { maskToken } from '../config.js';
import type { Command, Context } from '../context.js';
import { AtvError } from '../errors.js';
import { EXIT } from '../exit-codes.js';
import type { State } from '../output.js';

type Status = 'ok' | 'warn' | 'fail';

interface Check {
  name: string;
  status: Status;
  detail: string;
  hint: string;
}

interface Info {
  version: string;
  bridge: { status: string; backend: string | null; python: string | null; pyatv: string | null; error: string | null };
  screen?: { enabled: boolean; status: string; ready: boolean; reason: string | null; pymobiledevice3: string | null };
  devices: number;
}

interface DeviceSummary {
  id: string;
  name: string;
  paired: boolean;
  screen?: string;
}

function screenCheck(screen: Info['screen'], device: DeviceSummary | undefined): Check {
  const warn = (detail: string, hint: string): Check => ({ name: 'screen', status: 'warn', detail, hint });
  if (!screen) return warn('unknown', 'update the plugin to a version with screen reading');
  if (!screen.enabled) return warn('off', 'optional: enable "Screen reading" in the agent-atv plugin settings');
  if (screen.status === 'installing') return warn(screen.reason ?? 'installing', 'wait a few minutes, then run agent-atv doctor again');
  if (screen.status !== 'ready') {
    return warn(screen.reason ?? screen.status, 'ask the user to fix the error in the Homebridge log, then restart Homebridge');
  }
  const state = device?.screen ?? 'unknown';
  if (state === 'connected') {
    return { name: 'screen', status: 'ok', detail: `connected (pymobiledevice3 ${screen.pymobiledevice3 ?? 'n/a'})`, hint: '' };
  }
  if (state === 'unpaired' && device) return warn(`${device.name} not paired`, `run agent-atv pair ${device.id} --screen`);
  return warn(`${device?.name ?? 'device'} ${state}`, 'wake the Apple TV with agent-atv power on, then run agent-atv doctor again');
}

function failure(name: string, error: unknown): Check {
  if (error instanceof AtvError) return { name, status: 'fail', detail: `${error.message} (${error.code})`, hint: error.hint };
  throw error;
}

async function runChecks(ctx: Context): Promise<Check[]> {
  const checks: Check[] = [];
  const config = ctx.config();
  const url = config.url.value;
  const token = config.token.value;

  if (url === undefined || token === undefined) {
    checks.push({
      name: 'config',
      status: 'fail',
      detail: url === undefined ? 'no API URL configured' : `url ${url} (${config.url.source}), no token configured`,
      hint:
        url === undefined
          ? 'run agent-atv config set url http://<homebridge-host>:8787'
          : 'Copy the token from the plugin settings in the Homebridge UI, then run: agent-atv config set token -',
    });
    if (url === undefined) return checks;
  } else {
    checks.push({
      name: 'config',
      status: 'ok',
      detail: `url ${url} (${config.url.source}), token ${maskToken(token)} (${config.token.source}), device ${config.device.value} (${config.device.source})`,
      hint: '',
    });
  }

  const client = ctx.client();
  try {
    const health = await client.json<{ name: string; version: string }>('GET', '/health', { auth: false });
    checks.push({ name: 'health', status: 'ok', detail: `${health.name} ${health.version} at ${client.baseUrl}`, hint: '' });
  } catch (error) {
    checks.push(failure('health', error));
    return checks;
  }

  let info: Info;
  try {
    info = await client.json<Info>('GET', '/info');
    checks.push({ name: 'token', status: 'ok', detail: 'accepted', hint: '' });
  } catch (error) {
    checks.push(failure('token', error));
    return checks;
  }

  const { bridge } = info;
  checks.push(
    bridge.status === 'ready'
      ? {
          name: 'bridge',
          status: 'ok',
          detail: `ready (${bridge.backend ?? 'unknown'} backend, pyatv ${bridge.pyatv ?? 'n/a'}, python ${bridge.python ?? 'n/a'})`,
          hint: '',
        }
      : {
          name: 'bridge',
          status: 'fail',
          detail: `${bridge.status}${bridge.error ? `: ${bridge.error}` : ''}`,
          hint: 'wait a few seconds and run agent-atv doctor again; if it persists, ask the user to check the Homebridge log',
        },
  );

  let summaries: DeviceSummary[] = [];
  try {
    const { devices } = await client.json<{ devices: DeviceSummary[] }>('GET', '/devices');
    summaries = devices;
    const paired = devices.filter((device) => device.paired);
    checks.push(
      paired.length > 0
        ? { name: 'paired', status: 'ok', detail: `${paired.length} paired: ${paired.map((d) => d.name).join(', ')}`, hint: '' }
        : {
            name: 'paired',
            status: 'fail',
            detail: `no paired device (${devices.length} known)`,
            hint: 'Find the Apple TV with agent-atv scan, then run agent-atv pair <id>',
          },
    );
  } catch (error) {
    checks.push(failure('paired', error));
  }

  let deviceId: string | undefined;
  try {
    const state = await client.json<State>('GET', devicePath(ctx.device(), '/state'));
    deviceId = state.device.id;
    const label = `${state.device.name} (${state.device.id}) ${state.connection}`;
    checks.push(
      state.connection === 'connected'
        ? { name: 'device', status: 'ok', detail: label, hint: '' }
        : {
            name: 'device',
            status: 'fail',
            detail: label,
            hint: state.needsPairing
              ? `Pair again with: agent-atv pair ${state.device.id}`
              : 'Check that the Apple TV is on the network; the plugin keeps reconnecting.',
          },
    );
  } catch (error) {
    checks.push(failure('device', error));
  }

  checks.push(screenCheck(info.screen, summaries.find((summary) => summary.id === deviceId)));
  return checks;
}

export const doctor: Command = {
  name: 'doctor',
  usage: 'doctor',
  summary: 'check config, API, token, bridge, pairing, connection, screen reading',
  async run(ctx) {
    const checks = await runChecks(ctx);
    const ok = checks.every((check) => check.status !== 'fail');
    if (ctx.json) ctx.printJson({ checks, ok });
    else {
      for (const check of checks) {
        ctx.print(`${check.status} ${check.name}: ${check.detail}${check.status !== 'ok' && check.hint ? `; hint: ${check.hint}` : ''}`);
      }
    }
    return ok ? EXIT.ok : EXIT.failed;
  },
};
