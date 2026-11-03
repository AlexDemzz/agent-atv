import type { BridgeClient } from '../bridge/client';
import type { AgentAtvConfig } from '../config';
import type { DeviceManager } from '../devices/manager';
import type { PairingManager } from '../pairing/manager';
import { isFocusUnknown, type CaptureOptions, type FocusRead, type FocusReport, type Foreground, type ScreenService, type Settle, type Unavailable } from '../screen/service';
import { PLUGIN_NAME } from '../settings';
import { ACTION_KEYS, KEY_ACTIONS, KEYS, type KeyAction } from '../bridge/protocol';
import { ApiError, badRequest } from './errors';
import { oneOf, optionalInteger, optionalString, requiredBoolean, requiredInteger, requiredString } from './validate';
import { waitForState } from '../wait/waiter';
import { CONDITION_NAMES, evaluate, PLAYBACK_STATES, type Conditions } from '../wait/conditions';
import type { App, Keyboard } from '../bridge/protocol';
import type { Device } from '../devices/manager';
import type { Body, Route, RouteResult } from './server';

export interface RouteDeps {
  version: string;
  bridge: BridgeClient;
  devices: DeviceManager;
  pairing: PairingManager;
  screen: ScreenService;
  config: AgentAtvConfig;
}

const flag = (query: URLSearchParams, name: string): boolean => {
  const value = query.get(name);
  return value !== null && value !== '0' && value !== 'false';
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const FOCUS_POLL_MS = 250;
/** A foreground read takes about 0.5 s on a Pi; launches show up within about a second. */
const APP_POLL_MS = 500;
const APP_READ_MS = 5000;

/** Runs `read` every `everyMs`, start to start, after a first read made by the caller; returns stop. */
function poll(everyMs: number, signal: AbortSignal, read: () => Promise<void>): () => void {
  let running = true;
  void (async () => {
    let startedAt = Date.now();
    while (running && !signal.aborted) {
      await sleep(Math.max(0, startedAt + everyMs - Date.now()));
      if (!running) break;
      startedAt = Date.now();
      await read();
    }
  })();
  return () => {
    running = false;
  };
}

/** Whether an action's body asks for the settled focus (`"focus": true`); absent means no read. */
function wantsFocus(body: Body): boolean {
  if (body.focus === undefined || body.focus === null) return false;
  return requiredBoolean(body, 'focus');
}

/** Arrow keys move the focus within the screen: tvOS reports the move about 0.1 s after the key. */
const MOVE_WINDOW_MS = 350;
/** Other keys and launches may bring a new screen, focused later. */
const SCREEN_WINDOW_MS = 1000;
const ARROWS = new Set(['up', 'down', 'left', 'right']);

/** After the action: the move it caused, past the baseline; a plain read without one. */
async function withFocus(deps: RouteDeps, device: Device, wanted: boolean, settle?: Settle): Promise<{ focus?: FocusReport }> {
  return wanted ? { focus: await deps.screen.report(device, settle) } : {};
}

const settleAfter = (moves: number | undefined, windowMs = SCREEN_WINDOW_MS): Settle | undefined =>
  moves === undefined ? undefined : { moves, windowMs };

/** A link may open in the app already in front, which then never changes: take that app after this long. */
const LINK_SAME_APP_MS = 3000;

/**
 * Launches a link and waits for the app that opens it: one that was not in front before. When an app
 * was already in front, after LINK_SAME_APP_MS the app in front is taken for the one that opened it.
 */
async function openLink(
  deps: RouteDeps,
  device: Device,
  target: string,
  waitMs: number,
  signal: AbortSignal,
  focusWanted: boolean,
  moves: number | undefined,
): Promise<Record<string, unknown>> {
  const { devices, screen } = deps;
  const before = waitMs > 0 ? await screen.appReport(device) : undefined;
  const front = before?.available && before.kind === 'app' ? before.bundleId : undefined;
  await devices.call(device, 'app.launch', { target });
  let result: { foreground: boolean | null; seen?: Foreground; unknown?: ScreenProblem } = { foreground: false };
  if (waitMs > 0) {
    const another = (seen: Foreground) => seen.kind === 'app' && seen.bundleId !== front;
    result = await waitForeground(screen, device, another, 'agent-atv state app', front ? Math.min(waitMs, LINK_SAME_APP_MS) : waitMs, signal);
    if (!result.foreground && front && result.seen?.kind === 'app') result = { foreground: true, seen: result.seen };
  }
  const { foreground, seen, unknown } = result;
  const focus = await withFocus(deps, device, focusWanted, settleAfter(moves));
  const app = foreground && seen?.kind === 'app' ? { bundleId: seen.bundleId, name: seen.name } : null;
  return { ok: true, app, foreground, ...(unknown ? { foregroundUnknown: unknown } : {}), ...focus, state: devices.pluginState(device) };
}

const MAX_WIDTH = { min: 160, max: 3840 };

function screenshotOptions(body: Body): CaptureOptions {
  const hint = `Pass a width from ${MAX_WIDTH.min} to ${MAX_WIDTH.max}, e.g. agent-atv screenshot --max-width 1280 --jpeg`;
  let maxWidth: number | undefined;
  try {
    maxWidth = optionalInteger(body, 'maxWidth', MAX_WIDTH.min, MAX_WIDTH.max);
  } catch (error) {
    throw new ApiError('BAD_REQUEST', (error as ApiError).message, { field: 'maxWidth' }, { hint });
  }
  const format = body.format === undefined || body.format === null ? undefined : oneOf(body.format, ['png', 'jpeg'] as const, 'format');
  return { ...(maxWidth === undefined ? {} : { maxWidth }), ...(format === undefined ? {} : { format }) };
}

interface Press {
  key: string;
  action: KeyAction;
}

function parseKeys(body: Body): { presses: Press[]; intervalMs: number } {
  const keys = body.keys;
  if (!Array.isArray(keys) || keys.length === 0) throw badRequest('keys', 'keys must be a non-empty list');
  const presses: Press[] = [];
  keys.forEach((entry: unknown, index) => {
    const path = `keys[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw badRequest(path, `${path} must be an object like {"key": "up"}`);
    }
    const spec = entry as Body;
    if (typeof spec.key !== 'string' || !KEYS.includes(spec.key)) {
      throw badRequest(`${path}.key`, `${path}.key must be one of: ${KEYS.join(', ')}`);
    }
    const action = spec.action === undefined ? 'tap' : oneOf(spec.action, KEY_ACTIONS, `${path}.action`);
    if (action !== 'tap' && !(ACTION_KEYS as readonly string[]).includes(spec.key)) {
      throw badRequest(`${path}.action`, `${spec.key} only supports tap; double and hold work on ${ACTION_KEYS.join(', ')}`);
    }
    const count = optionalInteger(spec, 'count', 1, 50, `${path}.count`) ?? 1;
    for (let i = 0; i < count; i++) presses.push({ key: spec.key, action });
  });
  if (presses.length > 100) throw badRequest('keys', `At most 100 presses per request (got ${presses.length})`);
  const intervalMs = optionalInteger(body, 'intervalMs', 0, 5000) ?? 200;
  return { presses, intervalMs };
}

const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

/** Exact case-insensitive name first, then a unique case-insensitive prefix (DESIGN.md §3.5). */
function resolveAppName(apps: App[], name: string): App {
  const wanted = name.trim().toLowerCase();
  const exact = apps.filter((app) => app.name.toLowerCase() === wanted);
  if (exact.length === 1) return exact[0]!;
  const matches = exact.length > 1 ? exact : apps.filter((app) => app.name.toLowerCase().startsWith(wanted));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new ApiError('APP_NOT_FOUND', `No installed app is named "${name}"`, { target: name });
  throw new ApiError('AMBIGUOUS_APP', `"${name}" matches ${matches.length} apps`, {
    matches: matches.map(({ bundleId, name: appName }) => ({ bundleId, name: appName })),
  });
}

type ScreenProblem = Omit<Unavailable, 'available'>;

/** A read that failed or timed out over a connected tunnel; the next one may answer. */
const isPassing = (screen: ScreenService, device: Device, report: Unavailable): boolean =>
  report.code === 'SCREEN_FAILED' || (report.code === 'SCREEN_UNAVAILABLE' && screen.screenOf(device) === 'connected');

/**
 * Reads the foreground app until `bundleId` is in front or `waitMs` passed. `true`/`false` once a
 * read answered; `null` with why when none did (screen reading off, not paired, not connected).
 */
/** `wanted`: what in front ends the wait; `recheck`: how to check later without opening again. */
async function waitForeground(
  screen: ScreenService,
  device: Device,
  wanted: (foreground: Foreground) => boolean,
  recheck: string,
  waitMs: number,
  signal: AbortSignal,
): Promise<{ foreground: boolean | null; seen?: Foreground; unknown?: ScreenProblem }> {
  const deadline = Date.now() + waitMs;
  let seen: Foreground | undefined;
  for (;;) {
    const startedAt = Date.now();
    const report = await screen.appReport(device, Math.max(1, deadline - startedAt));
    if (report.available) {
      const { available: _available, ...foreground } = report;
      seen = foreground;
      if (wanted(seen)) return { foreground: true, seen };
    } else if (seen === undefined && !isPassing(screen, device, report)) {
      // Opening again would relaunch the app: check it instead once the tunnel is up.
      const hint = report.code === 'SCREEN_UNAVAILABLE' ? `check in a few seconds with ${recheck}` : report.hint;
      return { foreground: null, unknown: { code: report.code, reason: report.reason, hint } };
    }
    const now = Date.now();
    if (now >= deadline || signal.aborted) break;
    await sleep(Math.min(startedAt + APP_POLL_MS, deadline) - now);
  }
  return { foreground: seen === undefined ? null : false, seen };
}

function parseConditions(body: Body): { conditions: Conditions; timeoutMs: number } {
  const raw = body.conditions;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || Object.keys(raw).length === 0) {
    throw badRequest('conditions', `conditions must name at least one of: ${CONDITION_NAMES.join(', ')}`);
  }
  const conditions: Conditions = {};
  for (const [name, value] of Object.entries(raw as Body)) {
    const path = `conditions.${name}`;
    switch (name) {
      case 'app':
      case 'text':
      case 'focus':
        conditions[name] = requiredString(raw as Body, name, path);
        break;
      case 'playback':
        conditions.playback = oneOf(value, PLAYBACK_STATES, path);
        break;
      case 'power':
        conditions.power = oneOf(value, ['on', 'off'] as const, path);
        break;
      case 'keyboard':
        conditions.keyboard = oneOf(value, ['focused', 'unfocused'] as const, path);
        break;
      case 'idleMs':
        conditions.idleMs = requiredInteger(raw as Body, name, 0, 300_000, path);
        break;
      default:
        throw badRequest(path, `Unknown condition ${name}; use: ${CONDITION_NAMES.join(', ')}`);
    }
  }
  const timeoutMs = optionalInteger(body, 'timeoutMs', 1, 300_000) ?? 25_000;
  return { conditions, timeoutMs };
}

export function buildRoutes(deps: RouteDeps): Route[] {
  const { devices, bridge } = deps;
  return [
    {
      method: 'GET',
      path: '/v1/health',
      public: true,
      handler: () => ({ json: { ok: true, name: PLUGIN_NAME, version: deps.version } }),
    },
    {
      method: 'GET',
      path: '/v1/info',
      handler: async () => ({
        json: {
          version: deps.version,
          bridge: {
            status: bridge.status,
            backend: bridge.info?.backend ?? null,
            python: bridge.info?.python ?? null,
            pyatv: bridge.info?.pyatv ?? null,
            error: bridge.error,
          },
          screen: await deps.screen.info(),
          devices: devices.all().length,
        },
      }),
    },
    {
      method: 'POST',
      path: '/v1/screen',
      handler: async ({ body }) => {
        if (requiredBoolean(body, 'enabled') !== true) {
          throw new ApiError('BAD_REQUEST', 'Screen reading can only be turned on here', { field: 'enabled' }, {
            hint: 'turn it off in the plugin settings, then restart Homebridge',
          });
        }
        deps.screen.enable();
        return { json: { ok: true, screen: await deps.screen.info() } };
      },
    },
    {
      method: 'GET',
      path: '/v1/devices',
      handler: () => ({ json: { devices: devices.all().map((d) => devices.summary(d)) } }),
    },
    {
      method: 'POST',
      path: '/v1/scan',
      handler: async ({ body }) => {
        const timeoutMs = optionalInteger(body, 'timeoutMs', 100, 60_000);
        const found = await devices.scan(timeoutMs);
        return {
          json: {
            devices: found.map((scanned) => {
              const device = devices.get(scanned.id);
              return { ...scanned, paired: device ? devices.isPaired(device) : false };
            }),
          },
        };
      },
    },
    {
      method: 'GET',
      path: '/v1/devices/:device/state',
      handler: async ({ params, query }) => {
        const device = devices.resolve(params.device!);
        const focus = flag(query, 'focus') ? deps.screen.report(device) : undefined;
        const app = flag(query, 'app') ? deps.screen.appReport(device) : undefined;
        if (flag(query, 'refresh') && device.connection === 'connected' && bridge.status === 'ready') {
          await devices.refreshState(device);
        }
        return {
          json: {
            ...devices.pluginState(device),
            ...(app ? { app: await app } : {}),
            ...(focus ? { focus: await focus } : {}),
          },
        };
      },
    },
    {
      method: 'GET',
      path: '/v1/devices/:device/focus',
      handler: async ({ params }) => ({ json: await deps.screen.focus(devices.resolve(params.device!)) }),
    },
    {
      method: 'POST',
      path: '/v1/devices/:device/keys',
      handler: async ({ params, body }) => {
        const device = devices.resolve(params.device!);
        const { presses, intervalMs } = parseKeys(body);
        const focusWanted = wantsFocus(body);
        devices.requireConnected(device);
        // The worker reports focus moves only while it follows the focus: from before the keys.
        let moves = focusWanted ? await deps.screen.follow(device) : undefined;
        for (const [index, press] of presses.entries()) {
          if (index > 0 && intervalMs > 0) await sleep(intervalMs);
          // The report is about the last key: earlier moves must not stand for the screen it brings.
          if (moves !== undefined && index > 0 && index === presses.length - 1) moves = (await deps.screen.follow(device)) ?? moves;
          try {
            await devices.call(device, 'key', { key: press.key, action: press.action });
          } catch (error) {
            const apiError = error as ApiError;
            throw new ApiError(apiError.code, apiError.message, { ...apiError.details, pressed: index }, {
              hint: apiError.hint,
              headers: apiError.headers,
            });
          }
        }
        const windowMs = ARROWS.has(presses.at(-1)!.key) ? MOVE_WINDOW_MS : SCREEN_WINDOW_MS;
        const focus = await withFocus(deps, device, focusWanted, settleAfter(moves, windowMs));
        return { json: { ok: true, pressed: presses.length, ...focus, state: devices.pluginState(device) } };
      },
    },
    {
      method: 'GET',
      path: '/v1/devices/:device/apps',
      handler: async ({ params, query }) => {
        const device = devices.resolve(params.device!);
        return { json: { apps: await devices.listApps(device, flag(query, 'refresh')) } };
      },
    },
    {
      method: 'POST',
      path: '/v1/devices/:device/open',
      handler: async ({ params, body, signal }) => {
        const device = devices.resolve(params.device!);
        const target = requiredString(body, 'target').trim();
        const waitMs = optionalInteger(body, 'waitMs', 0, 60_000) ?? 15_000;
        const focusWanted = wantsFocus(body);
        devices.requireConnected(device);
        const moves = focusWanted ? await deps.screen.follow(device) : undefined;
        if (target.includes('://')) {
          return { json: await openLink(deps, device, target, waitMs, signal, focusWanted, moves) };
        }
        let app: App;
        if (BUNDLE_ID.test(target)) {
          const known = await devices.listApps(device, false).catch(() => [] as App[]);
          app = known.find((a) => a.bundleId === target) ?? { bundleId: target, name: target };
        } else {
          app = resolveAppName(await devices.listApps(device, false), target);
        }
        await devices.call(device, 'app.launch', { target: app.bundleId });
        const isApp = (seen: Foreground) => seen.kind === 'app' && seen.bundleId === app.bundleId;
        const { foreground, seen, unknown } =
          waitMs > 0 ? await waitForeground(deps.screen, device, isApp, `agent-atv wait --app ${app.bundleId}`, waitMs, signal) : { foreground: false };
        const focus = await withFocus(deps, device, focusWanted, settleAfter(moves));
        const shown = foreground && seen?.kind === 'app' ? { bundleId: seen.bundleId, name: seen.name } : app;
        return {
          json: {
            ok: true,
            app: shown,
            foreground,
            ...(unknown ? { foregroundUnknown: unknown } : {}),
            ...focus,
            state: devices.pluginState(device),
          },
        };
      },
    },
    {
      method: 'GET',
      path: '/v1/devices/:device/keyboard',
      handler: async ({ params }) => {
        const device = devices.resolve(params.device!);
        devices.requireConnected(device);
        const keyboard = await devices.call<Keyboard>(device, 'keyboard.get');
        return { json: { focus: keyboard.focus, text: keyboard.text } };
      },
    },
    {
      method: 'POST',
      path: '/v1/devices/:device/keyboard',
      handler: async ({ params, body }) => {
        const device = devices.resolve(params.device!);
        const op = oneOf(body.op, ['set', 'append', 'clear'] as const, 'op');
        const text = optionalString(body, 'text');
        if (op !== 'clear' && text === undefined) throw badRequest('text', `text is required for op ${op}`);
        const focusWanted = wantsFocus(body);
        devices.requireConnected(device);
        if (focusWanted) await deps.screen.follow(device);
        const keyboard = await devices.call<Keyboard>(device, `keyboard.${op}`, op === 'clear' ? {} : { text });
        devices.patchState(device, { keyboard: { focus: keyboard.focus, text: keyboard.text } });
        // Typing does not move the focus: a plain read, of the element focused before.
        const focus = await withFocus(deps, device, focusWanted);
        return {
          json: { ok: true, keyboard: { focus: keyboard.focus, text: keyboard.text }, ...focus, state: devices.pluginState(device) },
        };
      },
    },
    {
      method: 'POST',
      path: '/v1/devices/:device/power',
      handler: async ({ params, body }) => {
        const device = devices.resolve(params.device!);
        const on = requiredBoolean(body, 'on');
        devices.requireConnected(device);
        const { power } = await devices.call<{ power: 'on' | 'off' | 'unknown' }>(device, 'power.set', { on });
        devices.patchState(device, { power });
        return { json: { ok: true, power, state: devices.pluginState(device) } };
      },
    },
    {
      method: 'POST',
      path: '/v1/devices/:device/volume',
      handler: async ({ params, body }) => {
        const device = devices.resolve(params.device!);
        const level = requiredInteger(body, 'level', 0, 100);
        devices.requireConnected(device);
        const { volume } = await devices.call<{ volume: number | null }>(device, 'volume.set', { level });
        devices.patchState(device, { volume });
        return { json: { ok: true, volume, state: devices.pluginState(device) } };
      },
    },
    {
      method: 'POST',
      path: '/v1/devices/:device/seek',
      handler: async ({ params, body }) => {
        const device = devices.resolve(params.device!);
        const position = requiredInteger(body, 'position', 0, Number.MAX_SAFE_INTEGER);
        devices.requireConnected(device);
        await devices.call(device, 'seek', { position });
        return { json: { ok: true, state: devices.pluginState(device) } };
      },
    },
    {
      method: 'POST',
      path: '/v1/devices/:device/wait',
      handler: async ({ params, body, signal }) => {
        const device = devices.resolve(params.device!);
        const { conditions, timeoutMs } = parseConditions(body);
        const waitStartedAt = Date.now();
        // The focused element has no change events: poll it while the wait runs.
        let read: FocusRead | undefined;
        const stops: (() => void)[] = [];
        // A read from before the app or playback changed may show another screen.
        const focus = () => (read && deps.screen.isCurrent(device, read) ? read.element : undefined);
        const readFocus = async (): Promise<FocusRead | undefined> => {
          try {
            return await deps.screen.read(device);
          } catch (error) {
            // Known from the next focus move on, which is often what the wait is for.
            if (isFocusUnknown(error)) return undefined;
            throw error;
          }
        };
        // The foreground app has no change events either; a failed poll keeps the last read.
        let app: Foreground | undefined;
        try {
          if (conditions.focus !== undefined) {
            // Its polls keep the worker following.
            await deps.screen.follow(device);
            read = await readFocus();
            stops.push(poll(FOCUS_POLL_MS, signal, async () => void (read = await readFocus().catch(() => read))));
          }
          if (conditions.app !== undefined) {
            try {
              app = await deps.screen.foreground(device, timeoutMs);
            } catch (error) {
              // Nothing but the shell in front, as between two apps: the next poll may tell.
              if (!(error instanceof ApiError && error.code === 'SCREEN_FAILED')) throw error;
            }
            stops.push(
              poll(APP_POLL_MS, signal, async () => void (app = await deps.screen.foreground(device, APP_READ_MS).catch(() => app))),
            );
          }
        } catch (error) {
          for (const stop of stops) stop();
          throw error;
        }
        const check = () =>
          evaluate(devices.pluginState(device), conditions, { now: Date.now(), waitStartedAt, focus: focus(), app: app ?? null });
        try {
          await waitForState(devices, device, () => check().satisfied, timeoutMs, signal);
        } finally {
          for (const stop of stops) stop();
        }
        const result = check();
        const elapsedMs = Date.now() - waitStartedAt;
        const state = devices.pluginState(device);
        const screenPart = {
          ...(conditions.app === undefined ? {} : { app: app ?? null }),
          ...(conditions.focus === undefined ? {} : { focus: focus() ?? null }),
        };
        if (result.satisfied) return { json: { ok: true, matched: result.matched, elapsedMs, ...screenPart, state } };
        const waitingFor = result.pending.map((name) => `${name}=${String(conditions[name as keyof Conditions])}`).join(', ');
        throw new ApiError('WAIT_TIMEOUT', `Timed out after ${timeoutMs}ms waiting for ${waitingFor}`, {
          elapsedMs,
          pending: result.pending,
          ...screenPart,
          state,
        });
      },
    },
    {
      method: 'POST',
      path: '/v1/devices/:device/screenshot',
      handler: async ({ params, body }): Promise<RouteResult> => {
        const device = devices.resolve(params.device!);
        const ifNoneMatch = optionalString(body, 'ifNoneMatch');
        const options = screenshotOptions(body);
        const result = await deps.screen.capture(device, ifNoneMatch, options);
        if (!result.changed) return { status: 304, headers: { 'X-Agent-ATV-Sha256': result.sha256 } };
        return {
          binary: { data: result.image, contentType: `image/${result.format}` },
          headers: {
            'X-Agent-ATV-Sha256': result.sha256,
            'X-Agent-ATV-Width': String(result.width),
            'X-Agent-ATV-Height': String(result.height),
            'X-Agent-ATV-Captured-At': result.capturedAt,
            'X-Agent-ATV-Duration-Ms': String(result.durationMs),
          },
        };
      },
    },
    {
      method: 'POST',
      path: '/v1/devices/:device/pair',
      handler: async ({ params, body }) => {
        const device = devices.resolve(params.device!, { forPairing: true });
        const protocol =
          body.protocol === undefined ? undefined : oneOf(body.protocol, ['companion', 'airplay', 'remotepairing'] as const, 'protocol');
        return { json: await deps.pairing.begin(device, protocol) };
      },
    },
    {
      method: 'POST',
      path: '/v1/pairings/:pairingId/pin',
      handler: async ({ params, body }) => {
        const pin = body.pin;
        if (typeof pin !== 'string' || !/^\d{4,8}$/.test(pin)) throw badRequest('pin', 'pin must be the digits shown on the TV, as a string');
        return { json: await deps.pairing.pin(params.pairingId!, pin) };
      },
    },
    {
      method: 'DELETE',
      path: '/v1/pairings/:pairingId',
      handler: async ({ params }) => {
        await deps.pairing.cancel(params.pairingId!);
        return { json: { ok: true } };
      },
    },
    {
      method: 'DELETE',
      path: '/v1/devices/:device/pairing',
      handler: async ({ params }) => {
        const device = devices.resolve(params.device!);
        await devices.unpair(device);
        await deps.screen.forget(device);
        return { json: { ok: true } };
      },
    },
  ];
}
