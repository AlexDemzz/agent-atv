import { EventEmitter } from 'node:events';
import { ACCESS_DENIED_HINT, ApiError, toApiError } from '../api/errors';
import { BridgeError, type BridgeClient } from '../bridge/client';
import type { App, BridgeState, DeviceInfo, Json, ScanDevice } from '../bridge/protocol';
import type { AgentAtvConfig, DeviceConfig } from '../config';
import { errorMessage, type Logger } from '../logger';
import type { Credentials, DeviceRecord, DeviceStore } from './store';

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'unpaired';

/** Bridge State plus the plugin fields of DESIGN.md §3.4. */
export interface PluginState extends BridgeState {
  seq: number;
  changedAt: string;
  connection: ConnectionStatus;
  needsPairing: boolean;
}

export interface DeviceSummary {
  id: string;
  name: string;
  address: string | null;
  model: string | null;
  version: string | null;
  paired: boolean;
  needsPairing: boolean;
  connection: ConnectionStatus;
  protocols: { companion: boolean; airplay: boolean };
  /** Screen reading (DESIGN.md §6): `off`, `starting`, `unpaired`, `connecting`, `connected` or `disconnected`. */
  screen: string;
}

export interface Device {
  id: string;
  config: DeviceConfig | undefined;
  scan: ScanDevice | undefined;
  record: DeviceRecord | undefined;
  state: BridgeState;
  seq: number;
  changedAtMs: number;
  /** When the now-playing app or the playback state last changed: the screen did too. */
  screenChangedAtMs: number;
  connection: ConnectionStatus;
  needsPairing: boolean;
  retryAttempt: number;
  retryTimer: NodeJS.Timeout | null;
  /** The in-flight bridge `connect`, if any. */
  connectAttempt: Promise<void> | null;
  accessDeniedWarned: boolean;
  unreachableWarned: boolean;
  apps: { fetchedAtMs: number; list: App[] } | null;
}

export interface ManagerEvents {
  state: [Device];
  connected: [Device];
}

const DISCOVERY_INTERVAL_MS = 5 * 60_000;
const RETRY_MAX_S = 120;
const APPS_TTL_MS = 10 * 60_000;

const idlePlaying = (): BridgeState['playing'] => ({
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

/** Stable comparison key: the State without `playing.position`. */
function comparable(state: BridgeState): string {
  return JSON.stringify({ ...state, playing: { ...state.playing, position: null } });
}

const pairedOf = (device: Device): boolean => typeof device.record?.credentials.companion === 'string';

/** Owns every known Apple TV: discovery, connection supervision, the State cache and seq. */
export class DeviceManager extends EventEmitter<ManagerEvents> {
  private readonly devices = new Map<string, Device>();
  private discoveryTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly config: AgentAtvConfig;
  private readonly bridge: BridgeClient;
  private readonly store: DeviceStore;
  private readonly log: Logger;
  /** Set by the screen service. */
  screenStatus: (device: Device) => string = () => 'off';

  constructor(options: { bridge: BridgeClient; store: DeviceStore; config: AgentAtvConfig; log: Logger }) {
    super();
    this.bridge = options.bridge;
    this.store = options.store;
    this.config = options.config;
    this.log = options.log;
  }

  async load(): Promise<void> {
    for (const record of await this.store.loadAll()) {
      const device = this.upsert(record.id);
      device.record = record;
      if (record.apps) device.apps = { fetchedAtMs: Date.parse(record.apps.fetchedAt) || 0, list: record.apps.list };
      this.refreshSkeleton(device);
    }
    for (const entry of this.config.devices) {
      const existing = this.findByIdentifier(entry.id);
      const device = existing ?? this.upsert(entry.id.toUpperCase());
      device.config = entry;
      this.refreshSkeleton(device);
    }
    for (const device of this.devices.values()) device.connection = pairedOf(device) ? 'connecting' : 'unpaired';
  }

  startSupervision(): void {
    this.bridge.on('ready', () => {
      for (const device of this.devices.values()) {
        device.retryAttempt = 0;
        this.clearRetry(device);
        this.connectSafely(device);
      }
    });
    this.bridge.on('exit', () => {
      for (const device of this.devices.values()) {
        this.clearRetry(device);
        if (pairedOf(device) && !device.needsPairing) this.setConnection(device, 'connecting');
      }
    });
    this.bridge.on('state', (id, state) => {
      const device = this.devices.get(id.toUpperCase());
      if (device) this.applyState(device, state);
    });
    this.bridge.on('connection', (id, event) => {
      const device = this.devices.get(id.toUpperCase());
      if (!device || !pairedOf(device)) return;
      this.log.warn(`${this.displayName(device)}: connection lost (${event.reason}); reconnecting`);
      this.setConnection(device, 'connecting');
      this.scheduleRetry(device);
    });

    void (async () => {
      if (this.config.discovery.enabled) await this.discover();
      for (const device of this.devices.values()) await this.connect(device);
    })().catch((error: unknown) => this.log.error(`Initial device setup failed: ${errorMessage(error)}`));

    if (this.config.discovery.enabled) {
      this.discoveryTimer = setInterval(() => void this.discover(), DISCOVERY_INTERVAL_MS);
      this.discoveryTimer.unref();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    for (const device of this.devices.values()) this.clearRetry(device);
  }

  all(): Device[] {
    return [...this.devices.values()];
  }

  get(id: string): Device | undefined {
    return this.devices.get(id.toUpperCase());
  }

  isPaired(device: Device): boolean {
    return pairedOf(device);
  }

  displayName(device: Device): string {
    return device.config?.name ?? device.record?.name ?? device.scan?.name ?? device.state.device.name ?? device.id;
  }

  address(device: Device): string | null {
    return device.config?.address ?? device.scan?.address ?? device.record?.address ?? device.state.device.address ?? null;
  }

  /**
   * DESIGN.md §3.2 device addressing. With `forPairing`, `default` is the only known device,
   * paired or not, so a first `agent-atv pair` needs no id.
   */
  resolve(ref: string, { forPairing = false }: { forPairing?: boolean } = {}): Device {
    const wanted = ref.trim().toLowerCase();
    if (wanted === 'default') {
      const candidates = forPairing ? this.all() : this.all().filter(pairedOf);
      if (candidates.length === 0) {
        if (forPairing) {
          throw new ApiError('DEVICE_NOT_FOUND', 'No Apple TV is known yet', { device: ref }, {
            hint: 'Find one with agent-atv scan, then pair it with: agent-atv pair <id>',
          });
        }
        throw new ApiError('NOT_PAIRED', 'No Apple TV is paired yet', {}, {
          hint: 'Find one with agent-atv scan, then pair it with: agent-atv pair <id>',
        });
      }
      if (candidates.length > 1) {
        throw new ApiError(
          'AMBIGUOUS_DEVICE',
          `${candidates.length} Apple TVs are ${forPairing ? 'known' : 'paired'}; pick one`,
          { devices: candidates.map((d) => ({ id: d.id, name: this.displayName(d) })) },
        );
      }
      return candidates[0]!;
    }
    const byId = this.devices.get(ref.trim().toUpperCase()) ?? this.findByIdentifier(ref.trim());
    if (byId) return byId;
    const byName = this.all().filter((d) =>
      [this.displayName(d), d.state.device.name, d.config?.name].some((n) => n?.toLowerCase() === wanted),
    );
    if (byName.length === 1) return byName[0]!;
    if (byName.length > 1) {
      throw new ApiError('AMBIGUOUS_DEVICE', `Several Apple TVs are named ${ref}`, {
        devices: byName.map((d) => ({ id: d.id, name: this.displayName(d) })),
      });
    }
    throw new ApiError('DEVICE_NOT_FOUND', `No Apple TV matches "${ref}"`, { device: ref });
  }

  pluginState(device: Device): PluginState {
    return {
      ...structuredClone(device.state),
      seq: device.seq,
      changedAt: new Date(device.changedAtMs).toISOString(),
      connection: device.connection,
      needsPairing: device.needsPairing,
    };
  }

  summary(device: Device): DeviceSummary {
    return {
      id: device.id,
      name: this.displayName(device),
      address: this.address(device),
      model: device.state.device.model ?? device.scan?.model ?? device.record?.model ?? null,
      version: device.state.device.version ?? device.scan?.version ?? device.record?.version ?? null,
      paired: pairedOf(device),
      needsPairing: device.needsPairing,
      connection: device.connection,
      protocols: { ...device.state.protocols },
      screen: this.screenStatus(device),
    };
  }

  /** Throws unless actions can be sent to the device right now. */
  requireConnected(device: Device): void {
    if (this.bridge.status !== 'ready') {
      const details: Json = { status: this.bridge.status };
      if (this.bridge.error) details.error = this.bridge.error;
      throw new ApiError('BRIDGE_UNAVAILABLE', `The Python bridge is not ready (${this.bridge.status})`, details);
    }
    const name = this.displayName(device);
    if (!pairedOf(device)) {
      throw new ApiError('NOT_PAIRED', `${name} is not paired`, { device: device.id }, {
        hint: `Pair it with: agent-atv pair ${device.id}`,
      });
    }
    if (device.needsPairing) {
      throw new ApiError('AUTH_FAILED', `${name} rejected the stored credentials`, { device: device.id }, {
        hint: `Pair it again in the plugin settings or with: agent-atv pair ${device.id}`,
      });
    }
    if (device.connection !== 'connected') {
      throw new ApiError('NOT_CONNECTED', `${name} is not connected (${device.connection})`, {
        device: device.id,
        connection: device.connection,
      });
    }
  }

  /** Sends a device request to the bridge, mapping failures to API errors. */
  async call<T = Json>(device: Device, method: string, params: Json = {}): Promise<T> {
    try {
      return await this.bridge.request<T>(method, { device: device.id, ...params });
    } catch (error) {
      if (error instanceof BridgeError && error.code === 'NOT_CONNECTED' && device.connection === 'connected') {
        this.setConnection(device, 'connecting');
        this.scheduleRetry(device);
      }
      throw toApiError(error, this.displayName(device));
    }
  }

  async refreshState(device: Device): Promise<void> {
    const state = await this.call<BridgeState>(device, 'state', { refresh: true });
    this.applyState(device, state);
  }

  /** Merges a partial State (e.g. an action result) into the cache. */
  patchState(device: Device, patch: Partial<BridgeState>): void {
    this.applyState(device, { ...device.state, ...patch });
  }

  async listApps(device: Device, refresh: boolean): Promise<App[]> {
    const cached = device.apps;
    if (cached && !refresh && Date.now() - cached.fetchedAtMs < APPS_TTL_MS) return cached.list;
    if (cached && !refresh && device.connection !== 'connected') return cached.list;
    this.requireConnected(device);
    const { apps } = await this.call<{ apps: App[] }>(device, 'apps.list');
    const fetchedAtMs = Date.now();
    device.apps = { fetchedAtMs, list: apps };
    if (device.record) {
      device.record.apps = { fetchedAt: new Date(fetchedAtMs).toISOString(), list: apps };
      await this.persist(device);
    }
    return apps;
  }

  async scan(timeoutMs?: number): Promise<ScanDevice[]> {
    const params: Json = {};
    if (timeoutMs !== undefined) params.timeoutMs = timeoutMs;
    if (this.config.discovery.hosts.length > 0) params.hosts = this.config.discovery.hosts;
    let result: { devices: ScanDevice[] };
    try {
      result = await this.bridge.request<{ devices: ScanDevice[] }>('scan', params);
    } catch (error) {
      throw toApiError(error, 'the network');
    }
    for (const found of result.devices) this.addScanned(found);
    return result.devices;
  }

  async setCredentials(device: Device, protocol: 'companion' | 'airplay', credentials: string): Promise<void> {
    const record = this.recordOf(device);
    record.credentials = { ...record.credentials, [protocol]: credentials };
    record.pairedAt = new Date().toISOString();
    device.needsPairing = false;
    await this.persist(device);
  }

  /** Remembers (or with null, forgets) which RemotePairing record belongs to the device. */
  async setRemotePairing(device: Device, identifier: string | null): Promise<void> {
    if ((device.record?.remotePairing?.identifier ?? null) === identifier) return;
    const record = this.recordOf(device);
    if (identifier === null) delete record.remotePairing;
    else record.remotePairing = { identifier };
    await this.persist(device);
  }

  private recordOf(device: Device): DeviceRecord {
    const record: DeviceRecord = device.record ?? {
      id: device.id,
      name: this.displayName(device),
      address: this.address(device),
      mac: device.scan?.mac ?? device.state.device.mac ?? null,
      model: device.scan?.model ?? device.state.device.model ?? null,
      version: device.scan?.version ?? device.state.device.version ?? null,
      credentials: {},
      pairedAt: null,
    };
    device.record = record;
    return record;
  }

  /** Disconnects if needed, then connects with the stored credentials. Never throws. */
  async reconnect(device: Device): Promise<void> {
    this.clearRetry(device);
    if (device.connectAttempt) await device.connectAttempt;
    if (device.connection === 'connected') {
      await this.bridge.request('disconnect', { device: device.id }).catch(() => undefined);
    }
    device.retryAttempt = 0;
    device.needsPairing = false;
    await this.connect(device, true);
  }

  async unpair(device: Device): Promise<void> {
    this.clearRetry(device);
    await this.bridge.request('disconnect', { device: device.id }).catch(() => undefined);
    if (device.record) {
      device.record.credentials = {};
      device.record.pairedAt = null;
      await this.persist(device);
    }
    device.needsPairing = false;
    device.state = { ...device.state, protocols: { companion: false, airplay: false } };
    this.setConnection(device, 'unpaired');
  }

  private async discover(): Promise<void> {
    try {
      await this.scan();
    } catch (error) {
      this.log.warn(`Apple TV discovery failed: ${errorMessage(error)}`);
    }
  }

  private addScanned(found: ScanDevice): Device {
    const id = found.id.toUpperCase();
    let device = this.devices.get(id);
    if (!device) {
      const placeholder = this.all().find(
        (d) => d.config && d.id !== id && found.identifiers.some((i) => i.toUpperCase() === d.config!.id.toUpperCase()),
      );
      device = this.upsert(id);
      if (placeholder && !pairedOf(placeholder)) {
        device.config = placeholder.config;
        this.devices.delete(placeholder.id);
      }
      device.connection = pairedOf(device) ? 'connecting' : 'unpaired';
    }
    device.scan = found;
    if (!device.config) device.config = this.config.devices.find((c) => found.identifiers.some((i) => i.toUpperCase() === c.id.toUpperCase()));
    this.refreshSkeleton(device);
    return device;
  }

  private findByIdentifier(identifier: string): Device | undefined {
    const wanted = identifier.toUpperCase();
    return this.all().find(
      (d) =>
        d.id === wanted ||
        d.config?.id.toUpperCase() === wanted ||
        d.scan?.identifiers.some((i) => i.toUpperCase() === wanted) === true ||
        d.record?.mac?.toUpperCase() === wanted,
    );
  }

  private upsert(id: string): Device {
    const existing = this.devices.get(id);
    if (existing) return existing;
    const now = Date.now();
    const device: Device = {
      id,
      config: undefined,
      scan: undefined,
      record: undefined,
      state: {
        device: { id, name: id, model: null, os: null, version: null, address: null, mac: null },
        power: 'unknown',
        nowPlaying: null,
        playing: idlePlaying(),
        keyboard: { focus: 'unknown', text: null },
        volume: null,
        protocols: { companion: false, airplay: false },
      },
      seq: 1,
      changedAtMs: now,
      screenChangedAtMs: now,
      connection: 'unpaired',
      needsPairing: false,
      retryAttempt: 0,
      retryTimer: null,
      connectAttempt: null,
      accessDeniedWarned: false,
      unreachableWarned: false,
      apps: null,
    };
    this.devices.set(id, device);
    return device;
  }

  /** Keeps the skeleton's device info in line with what the scan or store know, until a real State arrives. */
  private refreshSkeleton(device: Device): void {
    if (device.state.protocols.companion) return;
    const info: DeviceInfo = {
      id: device.id,
      name: this.displayName(device),
      model: device.scan?.model ?? device.record?.model ?? device.state.device.model ?? null,
      os: device.scan?.os ?? device.state.device.os ?? (device.record ? 'tvOS' : null),
      version: device.scan?.version ?? device.record?.version ?? device.state.device.version ?? null,
      address: this.address(device),
      mac: device.scan?.mac ?? device.record?.mac ?? device.state.device.mac ?? null,
    };
    device.state = { ...device.state, device: info };
  }

  private applyState(device: Device, state: BridgeState): void {
    const changed = comparable(device.state) !== comparable(state);
    if (device.state.nowPlaying?.bundleId !== state.nowPlaying?.bundleId || device.state.playing.state !== state.playing.state) {
      device.screenChangedAtMs = Date.now();
    }
    device.state = structuredClone(state);
    if (changed) {
      device.seq += 1;
      device.changedAtMs = Date.now();
    }
    this.emit('state', device);
  }

  private setConnection(device: Device, connection: ConnectionStatus): void {
    if (device.connection === connection) return;
    device.connection = connection;
    this.emit('state', device);
  }

  private connectSafely(device: Device): void {
    this.connect(device).catch((error: unknown) =>
      this.log.error(`${this.displayName(device)}: connection supervision failed: ${errorMessage(error)}`),
    );
  }

  private async connect(device: Device, force = false): Promise<void> {
    if (this.stopped || !pairedOf(device) || (device.needsPairing && !force) || device.connectAttempt) return;
    if (device.connection === 'connected' && !force) return;
    if (this.bridge.status !== 'ready') return;
    const attempt = this.attemptConnect(device);
    device.connectAttempt = attempt;
    try {
      await attempt;
    } finally {
      device.connectAttempt = null;
    }
  }

  private async attemptConnect(device: Device): Promise<void> {
    this.clearRetry(device);
    this.setConnection(device, 'connecting');
    const credentials: Credentials = {};
    if (device.record?.credentials.companion) credentials.companion = device.record.credentials.companion;
    if (device.record?.credentials.airplay) credentials.airplay = device.record.credentials.airplay;
    const params: Json = { device: device.id, credentials };
    const address = this.address(device);
    if (address) params.address = address;
    try {
      const state = await this.bridge.request<BridgeState>('connect', params);
      if (this.stopped || !pairedOf(device)) return;
      device.retryAttempt = 0;
      device.accessDeniedWarned = false;
      device.unreachableWarned = false;
      device.connection = 'connected';
      this.applyState(device, state);
      await this.rememberDeviceInfo(device, state.device);
      this.log.info(`${this.displayName(device)}: connected`);
      this.emit('connected', device);
    } catch (error) {
      if (this.stopped || !pairedOf(device)) return;
      this.onConnectError(device, error);
    }
  }

  private onConnectError(device: Device, error: unknown): void {
    const name = this.displayName(device);
    const code = error instanceof BridgeError ? error.code : 'INTERNAL';
    if (code === 'AUTH_FAILED') {
      device.needsPairing = true;
      this.setConnection(device, 'disconnected');
      this.emit('state', device);
      this.log.warn(`${name}: credentials rejected, pair again in the plugin settings or with: agent-atv pair ${device.id}`);
      return;
    }
    if (code === 'BRIDGE_UNAVAILABLE') return;
    if (code === 'ACCESS_DENIED') {
      if (!device.accessDeniedWarned) {
        device.accessDeniedWarned = true;
        this.log.warn(`${name}: the Apple TV refused the remote control channel. ${ACCESS_DENIED_HINT}`);
      }
      this.scheduleRetry(device, RETRY_MAX_S);
      return;
    }
    const failure = `${code}: ${errorMessage(error)}`;
    if (device.unreachableWarned) {
      this.log.debug(`${name}: connect failed (${failure})`);
    } else {
      device.unreachableWarned = true;
      this.log.warn(`${name}: cannot connect (${failure}); retrying in the background`);
    }
    this.scheduleRetry(device);
  }

  private scheduleRetry(device: Device, fixedSeconds?: number): void {
    if (this.stopped) return;
    this.clearRetry(device);
    const seconds = fixedSeconds ?? Math.min(RETRY_MAX_S, 2 ** (device.retryAttempt + 1));
    device.retryAttempt += 1;
    device.retryTimer = setTimeout(() => {
      device.retryTimer = null;
      this.connectSafely(device);
    }, seconds * 1000);
    device.retryTimer.unref();
  }

  private clearRetry(device: Device): void {
    if (device.retryTimer) clearTimeout(device.retryTimer);
    device.retryTimer = null;
  }

  private async rememberDeviceInfo(device: Device, info: DeviceInfo): Promise<void> {
    const record = device.record;
    if (!record) return;
    const next = {
      name: record.name || info.name,
      address: info.address ?? record.address,
      mac: info.mac ?? record.mac,
      model: info.model ?? record.model,
      version: info.version ?? record.version,
    };
    if (Object.entries(next).every(([key, value]) => record[key as keyof typeof next] === value)) return;
    Object.assign(record, next);
    await this.persist(device);
  }

  private async persist(device: Device): Promise<void> {
    if (!device.record) return;
    try {
      await this.store.save(device.record);
    } catch (error) {
      this.log.error(`Cannot save ${this.displayName(device)}: ${errorMessage(error)}`);
    }
  }
}
