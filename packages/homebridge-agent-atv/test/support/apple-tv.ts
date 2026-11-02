import { BridgeFailure, type FakeBridge, type Params } from './fake-bridge';

export const DEVICE_ID = 'A1B2C3D4E5F6';
export const COMPANION_CREDS = 'companion-secret-creds';
export const AIRPLAY_CREDS = 'airplay-secret-creds';
export const GOOD_PIN = '1234';

export interface TvState {
  device: Record<string, unknown>;
  power: string;
  nowPlaying: { bundleId: string; name: string } | null;
  playing: Record<string, unknown>;
  keyboard: { focus: string; text: string | null };
  volume: number | null;
  protocols: { companion: boolean; airplay: boolean };
}

export const scanDevice = (overrides: Record<string, unknown> = {}) => ({
  id: DEVICE_ID,
  name: 'Living Room',
  address: '192.168.1.50',
  mac: 'A1:B2:C3:D4:E5:F6',
  model: 'Apple TV 4K (gen 3)',
  os: 'tvOS',
  version: '27.2',
  identifiers: ['0E5C1C1E-3A4B-4C7D-9E2F-6A1B2C3D4E5F', 'A1:B2:C3:D4:E5:F6', DEVICE_ID],
  services: [
    { protocol: 'companion', port: 49153, pairing: 'mandatory' },
    { protocol: 'airplay', port: 7000, pairing: 'mandatory' },
  ],
  ...overrides,
});

export const idlePlaying = () => ({
  state: 'idle',
  mediaType: 'unknown',
  title: null,
  artist: null,
  album: null,
  seriesName: null,
  season: null,
  episode: null,
  position: null,
  totalTime: null,
});

export const APPS = [
  { bundleId: 'com.netflix.Netflix', name: 'Netflix' },
  { bundleId: 'com.apple.TVSearch', name: 'Search' },
  { bundleId: 'com.apple.TVSettings', name: 'Settings' },
  { bundleId: 'com.apple.TVWatchList', name: 'TV' },
  { bundleId: 'com.google.ios.youtube', name: 'YouTube' },
];

export interface AppleTvOptions {
  /** pair.verify accepts the Companion credentials as AirPlay credentials. */
  companionWorksForAirplay?: boolean;
  /** Called with each app it launches (bundle id targets), as it comes to the foreground. */
  onLaunch?: (app: { bundleId: string; name: string }) => void;
}

/**
 * Scripts `bridge` as a single Apple TV ("Living Room"), close to the bridge's fake backend.
 * Tests mutate `tv.state` and call `tv.push()` to emit a state event.
 */
export function installAppleTv(bridge: FakeBridge, options: AppleTvOptions = {}) {
  let pairingCounter = 0;
  const pairings = new Map<string, string>();
  const connected = new Set<string>();
  const state: TvState = {
    device: {
      id: DEVICE_ID,
      name: 'Living Room',
      model: 'Apple TV 4K (gen 3)',
      os: 'tvOS',
      version: '27.2',
      address: '192.168.1.50',
      mac: 'A1:B2:C3:D4:E5:F6',
    },
    power: 'on',
    nowPlaying: { bundleId: 'com.apple.TVWatchList', name: 'TV' },
    playing: idlePlaying(),
    keyboard: { focus: 'unfocused', text: null },
    volume: 50,
    protocols: { companion: true, airplay: true },
  };

  const requireConnected = (params: Params) => {
    if (!connected.has(String(params.device))) {
      throw new BridgeFailure('NOT_CONNECTED', `Device ${String(params.device)} is not connected`, {
        device: params.device,
      });
    }
  };
  const snapshot = () => structuredClone(state);
  const push = () => bridge.event('state', DEVICE_ID, snapshot());
  const keyboardResult = () => ({ focus: state.keyboard.focus, text: state.keyboard.text });
  const requireFocus = () => {
    if (state.keyboard.focus !== 'focused') throw new BridgeFailure('KEYBOARD_NOT_FOCUSED', 'No text field');
  };

  bridge
    .handle('scan', () => ({ devices: [scanDevice()] }))
    .handle('pair.begin', (params) => {
      const pairingId = `p-${String(++pairingCounter).padStart(12, '0')}`;
      pairings.set(pairingId, String(params.protocol));
      return { pairingId, protocol: params.protocol, deviceProvidesPin: true };
    })
    .handle('pair.pin', (params) => {
      const protocol = pairings.get(String(params.pairingId));
      pairings.delete(String(params.pairingId));
      if (!protocol) throw new BridgeFailure('PAIRING_NOT_FOUND');
      if (params.pin === '0000') throw new BridgeFailure('PAIRING_BACKOFF', 'BackOff', { retryAfterSec: 30 });
      if (params.pin !== GOOD_PIN) throw new BridgeFailure('PAIRING_FAILED', 'Wrong PIN');
      return { protocol, credentials: protocol === 'companion' ? COMPANION_CREDS : AIRPLAY_CREDS };
    })
    .handle('pair.verify', (params) => ({
      valid:
        params.credentials === AIRPLAY_CREDS ||
        (options.companionWorksForAirplay === true && params.credentials === COMPANION_CREDS),
    }))
    .handle('connect', (params) => {
      const credentials = params.credentials as { companion?: string; airplay?: string };
      if (credentials.companion !== COMPANION_CREDS) throw new BridgeFailure('AUTH_FAILED', 'rejected');
      connected.add(String(params.device));
      state.protocols = { companion: true, airplay: credentials.airplay !== undefined };
      return snapshot();
    })
    .handle('disconnect', (params) => {
      connected.delete(String(params.device));
      return {};
    })
    .handle('state', (params) => {
      requireConnected(params);
      return snapshot();
    })
    .handle('key', (params) => {
      requireConnected(params);
      return {};
    })
    .handle('apps.list', (params) => {
      requireConnected(params);
      return { apps: APPS };
    })
    .handle('app.launch', (params) => {
      requireConnected(params);
      const target = String(params.target);
      if (target.includes('://')) return {};
      const app = APPS.find((a) => a.bundleId === target);
      if (!app) throw new BridgeFailure('LAUNCH_FAILED', `Cannot launch ${target}`, { target });
      if (options.onLaunch) setTimeout(() => options.onLaunch?.(app), 20);
      return {};
    })
    .handle('keyboard.get', (params) => {
      requireConnected(params);
      return keyboardResult();
    })
    .handle('keyboard.set', (params) => {
      requireConnected(params);
      requireFocus();
      state.keyboard.text = String(params.text);
      return keyboardResult();
    })
    .handle('keyboard.append', (params) => {
      requireConnected(params);
      requireFocus();
      state.keyboard.text = `${state.keyboard.text ?? ''}${String(params.text)}`;
      return keyboardResult();
    })
    .handle('keyboard.clear', (params) => {
      requireConnected(params);
      requireFocus();
      state.keyboard.text = '';
      return keyboardResult();
    })
    .handle('power.set', (params) => {
      requireConnected(params);
      state.power = params.on ? 'on' : 'off';
      return { power: state.power };
    })
    .handle('volume.set', (params) => {
      requireConnected(params);
      state.volume = Number(params.level);
      return { volume: state.volume };
    })
    .handle('seek', (params) => {
      requireConnected(params);
      state.playing.position = params.position;
      return {};
    });

  return {
    state,
    push,
    isConnected: () => connected.has(DEVICE_ID),
    dropConnection: () => {
      connected.delete(DEVICE_ID);
      bridge.event('connection', DEVICE_ID, {
        status: 'disconnected',
        reason: 'connection_lost',
        message: 'lost',
      });
    },
  };
}
