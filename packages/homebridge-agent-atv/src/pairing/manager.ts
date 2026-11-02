import { randomBytes } from 'node:crypto';
import { ApiError, toApiError } from '../api/errors';
import type { BridgeClient } from '../bridge/client';
import type { Json } from '../bridge/protocol';
import type { Device, DeviceManager, DeviceSummary } from '../devices/manager';
import { errorMessage, type Logger } from '../logger';
import type { ScreenService } from '../screen/service';

export type PairingProtocol = 'companion' | 'airplay' | 'remotepairing';

const SESSION_TTL_MS = 90_000;

interface Session {
  id: string;
  device: Device;
  flow: PairingProtocol[];
  step: number;
  bridgePairingId: string;
  timer: NodeJS.Timeout;
  busy: boolean;
  storedCredentials: boolean;
}

export interface PairingStep {
  pairingId: string;
  protocol: PairingProtocol;
  step: number;
  steps: number;
  message: string;
}

export type PinResult =
  | ({ status: 'next' } & PairingStep)
  /** `warning`: screen reading could not be paired; the rest is. */
  | { status: 'done'; device: DeviceSummary; warning?: string };

/** Multi-step pairing sessions (DESIGN.md §5.3), shared by the API, the CLI and the settings UI. */
export class PairingManager {
  private readonly sessions = new Map<string, Session>();
  private readonly expired = new Set<string>();

  constructor(
    private readonly options: {
      bridge: BridgeClient;
      devices: DeviceManager;
      screen: ScreenService;
      log: Logger;
      remoteName: string;
    },
  ) {}

  async begin(device: Device, protocol?: PairingProtocol): Promise<PairingStep & { device: { id: string; name: string } }> {
    const { devices } = this.options;
    const active = [...this.sessions.values()].find((s) => s.device === device);
    if (active) {
      throw new ApiError('PAIRING_IN_PROGRESS', `A pairing is already running for ${devices.displayName(device)}`, {
        pairingId: active.id,
      });
    }
    const flow: PairingProtocol[] = protocol
      ? [protocol]
      : ['companion', 'airplay', ...(this.options.screen.enabled ? (['remotepairing'] as const) : [])];
    const bridgePairingId = await this.beginStep(device, flow[0]!);
    const id = `p-${randomBytes(6).toString('hex')}`;
    const session: Session = { id, device, flow, step: 0, bridgePairingId, timer: this.expiryTimer(id), busy: false, storedCredentials: false };
    this.sessions.set(session.id, session);
    return { ...this.stepOf(session), device: { id: device.id, name: devices.displayName(device) } };
  }

  async pin(pairingId: string, pin: string): Promise<PinResult> {
    const { devices, log } = this.options;
    const session = this.sessionFor(pairingId);
    if (session.busy) {
      throw new ApiError('PAIRING_IN_PROGRESS', 'A PIN for this pairing is already being checked', { pairingId });
    }
    session.busy = true;
    const device = session.device;
    const protocol = session.flow[session.step]!;
    if (protocol !== 'remotepairing' && !/^\d{4}$/.test(pin)) {
      session.busy = false;
      throw new ApiError('BAD_REQUEST', `The ${protocol} PIN has 4 digits`, { field: 'pin' }, { hint: 'type the 4-digit PIN shown on the TV' });
    }
    try {
      let next = session.step + 1;
      if (protocol === 'remotepairing') {
        await this.options.screen.pairPin(device, pin);
        log.info(`${devices.displayName(device)}: paired screen reading`);
      } else {
        const result = await this.bridgeCall<{ protocol: PairingProtocol; credentials: string }>(device, 'pair.pin', {
          pairingId: session.bridgePairingId,
          pin,
        });
        await devices.setCredentials(device, protocol, result.credentials);
        session.storedCredentials = true;
        log.info(`${devices.displayName(device)}: paired ${protocol}`);
        if (protocol === 'companion' && session.flow[next] === 'airplay' && (await this.companionWorksForAirplay(device, result.credentials))) {
          await devices.setCredentials(device, 'airplay', result.credentials);
          log.info(`${devices.displayName(device)}: the Companion credentials also work for AirPlay`);
          next += 1;
        }
      }
      const nextProtocol = session.flow[next];
      if (nextProtocol === undefined) return await this.finish(session);
      try {
        session.bridgePairingId = await this.beginStep(device, nextProtocol);
      } catch (error) {
        if (nextProtocol !== 'remotepairing') throw error;
        const apiError = toApiError(error, devices.displayName(device));
        log.warn(`${devices.displayName(device)}: screen reading not paired: ${apiError.message}`);
        return await this.finish(session, `Screen reading not paired (${apiError.message}): ${apiError.hint}`);
      }
      session.step = next;
      clearTimeout(session.timer);
      session.timer = this.expiryTimer(session.id);
      return { status: 'next', ...this.stepOf(session) };
    } catch (error) {
      this.abandon(session);
      throw error;
    } finally {
      session.busy = false;
    }
  }

  async cancel(pairingId: string): Promise<void> {
    const session = this.sessions.get(pairingId);
    if (!session) throw new ApiError('PAIRING_NOT_FOUND', `No pairing ${pairingId}`, { pairingId });
    this.abandon(session);
    await this.cancelStep(session);
  }

  private async cancelStep(session: Session): Promise<void> {
    if (session.flow[session.step] === 'remotepairing') {
      await this.options.screen.pairCancel(session.device);
      return;
    }
    await this.options.bridge
      .request('pair.cancel', { pairingId: session.bridgePairingId })
      .catch((error: unknown) => this.options.log.debug(`pair.cancel failed: ${errorMessage(error)}`));
  }

  stop(): void {
    for (const session of this.sessions.values()) clearTimeout(session.timer);
    this.sessions.clear();
  }

  private stepOf(session: Session): PairingStep {
    const protocol = session.flow[session.step]!;
    const name = this.options.devices.displayName(session.device);
    return {
      pairingId: session.id,
      protocol,
      step: session.step + 1,
      steps: session.flow.length,
      message: protocol === 'remotepairing' ? `Enter the PIN shown on ${name} for screen reading` : `Enter the 4-digit PIN shown on ${name}`,
    };
  }

  private sessionFor(pairingId: string): Session {
    const session = this.sessions.get(pairingId);
    if (session) return session;
    if (this.expired.has(pairingId)) {
      throw new ApiError('PAIRING_EXPIRED', `Pairing ${pairingId} expired`, { pairingId });
    }
    throw new ApiError('PAIRING_NOT_FOUND', `No pairing ${pairingId}`, { pairingId });
  }

  private async finish(session: Session, warning?: string): Promise<PinResult> {
    const { devices } = this.options;
    this.forget(session);
    if (session.storedCredentials) await devices.reconnect(session.device);
    return { status: 'done', device: devices.summary(session.device), ...(warning ? { warning } : {}) };
  }

  private async companionWorksForAirplay(device: Device, credentials: string): Promise<boolean> {
    try {
      const { valid } = await this.bridgeCall<{ valid: boolean }>(device, 'pair.verify', {
        protocol: 'airplay',
        credentials,
      });
      return valid;
    } catch (error) {
      this.options.log.debug(`pair.verify failed, pairing AirPlay separately: ${errorMessage(error)}`);
      return false;
    }
  }

  /** Starts one step; the Apple TV then shows its PIN. Returns the bridge pairing id ('' for RemotePairing). */
  private async beginStep(device: Device, protocol: PairingProtocol): Promise<string> {
    if (protocol === 'remotepairing') {
      await this.options.screen.pairBegin(device);
      return '';
    }
    const result = await this.bridgeCall<{ pairingId: string }>(device, 'pair.begin', {
      protocol,
      remoteName: this.options.remoteName,
    });
    return result.pairingId;
  }

  private async bridgeCall<T>(device: Device, method: string, params: Json): Promise<T> {
    const { bridge, devices } = this.options;
    const full: Json = method === 'pair.pin' ? params : { device: device.id, ...this.addressOf(device), ...params };
    try {
      return await bridge.request<T>(method, full);
    } catch (error) {
      throw toApiError(error, devices.displayName(device));
    }
  }

  private addressOf(device: Device): Json {
    const address = this.options.devices.address(device);
    return address ? { address } : {};
  }

  private expiryTimer(pairingId: string): NodeJS.Timeout {
    const timer = setTimeout(() => {
      const session = this.sessions.get(pairingId);
      if (!session) return;
      this.abandon(session);
      this.expired.add(pairingId);
      void this.cancelStep(session);
    }, SESSION_TTL_MS);
    timer.unref();
    return timer;
  }

  private forget(session: Session): void {
    clearTimeout(session.timer);
    this.sessions.delete(session.id);
  }

  /** Ends an unfinished session; credentials stored by an earlier step are put to use right away. */
  private abandon(session: Session): void {
    this.forget(session);
    if (!session.storedCredentials) return;
    const { devices, log } = this.options;
    devices
      .reconnect(session.device)
      .catch((error: unknown) => log.error(`${devices.displayName(session.device)}: reconnect failed: ${errorMessage(error)}`));
  }
}
