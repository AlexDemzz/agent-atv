import { readFile } from 'node:fs/promises';
import type { API, Categories, CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import { toApiError } from '../api/errors';
import type { App } from '../bridge/protocol';
import type { AgentAtvConfig } from '../config';
import type { Device, DeviceManager } from '../devices/manager';
import { errorMessage, type Logger } from '../logger';
import { PLUGIN_NAME } from '../settings';

/** HAP `Categories.APPLE_TV`; the enum is ambient, so its value can't be read at runtime here. */
const APPLE_TV_CATEGORY = 24 as Categories;

interface Published {
  accessory: PlatformAccessory;
  television: Service;
  inputs: App[];
}

/** One external Television accessory per paired device (DESIGN.md §5.5). */
export class TelevisionAccessories {
  private readonly published = new Map<string, Published>();
  private readonly creating = new Set<string>();

  constructor(
    private readonly options: { api: API; devices: DeviceManager; config: AgentAtvConfig; log: Logger },
  ) {}

  start(): void {
    const { devices } = this.options;
    devices.on('connected', (device) => void this.ensure(device));
    devices.on('state', (device) => this.update(device));
    for (const device of devices.all()) if (device.connection === 'connected') void this.ensure(device);
  }

  private wanted(device: Device): boolean {
    return this.options.config.homekit.enabled && device.config?.homekit !== false;
  }

  private async ensure(device: Device): Promise<void> {
    if (!this.wanted(device) || this.published.has(device.id) || this.creating.has(device.id)) return;
    this.creating.add(device.id);
    try {
      const inputs = await this.pickInputs(device);
      const published = this.build(device, inputs);
      this.published.set(device.id, published);
      this.options.api.publishExternalAccessories(PLUGIN_NAME, [published.accessory]);
      this.update(device);
      await this.logSetupCode(this.options.devices.displayName(device));
    } catch (error) {
      this.options.log.error(`Cannot publish the HomeKit accessory: ${errorMessage(error)}`);
    } finally {
      this.creating.delete(device.id);
    }
  }

  private async pickInputs(device: Device): Promise<App[]> {
    const { devices, config, log } = this.options;
    let apps: App[] = [];
    try {
      apps = await devices.listApps(device, false);
    } catch (error) {
      log.warn(`${devices.displayName(device)}: no HomeKit inputs, the app list is unavailable (${errorMessage(error)})`);
    }
    const chosen =
      config.homekit.inputs.length > 0
        ? config.homekit.inputs
            .map((bundleId) => apps.find((app) => app.bundleId === bundleId) ?? { bundleId, name: bundleId })
        : [...apps].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return chosen.slice(0, config.homekit.maxInputs);
  }

  private build(device: Device, inputs: App[]): Published {
    const { api, devices, log } = this.options;
    const { Service: S, Characteristic: C, uuid } = api.hap;
    const name = devices.displayName(device);
    const accessory = new api.platformAccessory(name, uuid.generate(`agent-atv:${device.id}`), APPLE_TV_CATEGORY);

    const info = accessory.getService(S.AccessoryInformation) ?? accessory.addService(S.AccessoryInformation);
    info
      .setCharacteristic(C.Manufacturer, 'Apple')
      .setCharacteristic(C.Model, device.state.device.model ?? 'Apple TV')
      .setCharacteristic(C.SerialNumber, device.id)
      .setCharacteristic(C.FirmwareRevision, device.state.device.version ?? '0');

    const television = accessory.addService(S.Television, name, 'television');
    television.setCharacteristic(C.ConfiguredName, name);
    television.setCharacteristic(C.SleepDiscoveryMode, C.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);
    television
      .getCharacteristic(C.Active)
      .onGet(() => (device.state.power === 'on' ? C.Active.ACTIVE : C.Active.INACTIVE))
      .onSet((value) => {
        this.requireConnected(device);
        // HomeKit gives up on a write after 10 s and the Apple TV takes up to 20 s to confirm, so the
        // write answers once sent and Active follows the state events.
        devices
          .call<{ power: 'on' | 'off' | 'unknown' }>(device, 'power.set', { on: value === C.Active.ACTIVE })
          .then(({ power }) => devices.patchState(device, { power }))
          .catch((error: unknown) => {
            const failure = toApiError(error, devices.displayName(device));
            log.warn(`${devices.displayName(device)}: HomeKit power command failed: ${failure.message}; ${failure.hint}`);
          });
      });
    television
      .getCharacteristic(C.ActiveIdentifier)
      .onGet(() => this.activeIdentifier(device, inputs))
      .onSet(async (value) => {
        const input = inputs[Number(value) - 1];
        if (input) await this.act(device, () => devices.call(device, 'app.launch', { target: input.bundleId }));
      });

    const remoteKeys = new Map<number, string>([
      [C.RemoteKey.ARROW_UP, 'up'],
      [C.RemoteKey.ARROW_DOWN, 'down'],
      [C.RemoteKey.ARROW_LEFT, 'left'],
      [C.RemoteKey.ARROW_RIGHT, 'right'],
      [C.RemoteKey.SELECT, 'select'],
      [C.RemoteKey.BACK, 'menu'],
      [C.RemoteKey.EXIT, 'home'],
      [C.RemoteKey.PLAY_PAUSE, 'play_pause'],
      [C.RemoteKey.INFORMATION, 'top_menu'],
    ]);
    television.getCharacteristic(C.RemoteKey).onSet(async (value: CharacteristicValue) => {
      const key = remoteKeys.get(Number(value));
      if (key) await this.act(device, () => devices.call(device, 'key', { key, action: 'tap' }));
    });

    inputs.forEach((app, index) => {
      const input = accessory.addService(S.InputSource, app.name, `input-${app.bundleId}`);
      input
        .setCharacteristic(C.Identifier, index + 1)
        .setCharacteristic(C.ConfiguredName, app.name)
        .setCharacteristic(C.IsConfigured, C.IsConfigured.CONFIGURED)
        .setCharacteristic(C.InputSourceType, C.InputSourceType.APPLICATION)
        .setCharacteristic(C.CurrentVisibilityState, C.CurrentVisibilityState.SHOWN);
      television.addLinkedService(input);
    });

    const speaker = accessory.addService(S.TelevisionSpeaker, `${name} Speaker`, 'speaker');
    speaker
      .setCharacteristic(C.Active, C.Active.ACTIVE)
      .setCharacteristic(C.VolumeControlType, C.VolumeControlType.RELATIVE);
    speaker.getCharacteristic(C.Mute).onGet(() => false);
    speaker.getCharacteristic(C.VolumeSelector).onSet(async (value) => {
      const key = value === C.VolumeSelector.INCREMENT ? 'volume_up' : 'volume_down';
      await this.act(device, () => devices.call(device, 'key', { key, action: 'tap' }));
    });
    television.addLinkedService(speaker);

    return { accessory, television, inputs };
  }

  /** From the now-playing app: the foreground app is read on demand only, never followed. */
  private activeIdentifier(device: Device, inputs: App[]): number {
    const bundleId = device.state.nowPlaying?.bundleId;
    const index = bundleId ? inputs.findIndex((input) => input.bundleId === bundleId) : -1;
    return index + 1;
  }

  private update(device: Device): void {
    const published = this.published.get(device.id);
    if (!published) return;
    const { Characteristic: C } = this.options.api.hap;
    published.television.updateCharacteristic(C.Active, device.state.power === 'on' ? C.Active.ACTIVE : C.Active.INACTIVE);
    published.television.updateCharacteristic(C.ActiveIdentifier, this.activeIdentifier(device, published.inputs));
  }

  private async act(device: Device, action: () => Promise<unknown>): Promise<void> {
    this.requireConnected(device);
    try {
      await action();
    } catch (error) {
      throw this.failed(device, error);
    }
  }

  private requireConnected(device: Device): void {
    try {
      this.options.devices.requireConnected(device);
    } catch (error) {
      throw this.failed(device, error);
    }
  }

  private failed(device: Device, error: unknown): Error {
    const { api, devices, log } = this.options;
    log.warn(`${devices.displayName(device)}: HomeKit command failed: ${errorMessage(error)}`);
    return new api.hap.HapStatusError(api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  private async logSetupCode(name: string): Promise<void> {
    let pin: string | undefined;
    try {
      const config = JSON.parse(await readFile(this.options.api.user.configPath(), 'utf8')) as { bridge?: { pin?: string } };
      pin = config.bridge?.pin;
    } catch {
      pin = undefined;
    }
    this.options.log.info(
      `${name}: published as a HomeKit TV. Add it in the Home app (Add Accessory > More options) with the Homebridge setup code${pin ? ` ${pin}` : ''}.`,
    );
  }
}
