import { EventEmitter } from 'node:events';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as hap from '@homebridge/hap-nodejs';
import type { Service } from '@homebridge/hap-nodejs';

/** The parts of homebridge's PlatformAccessory the plugin uses, backed by a real HAP Accessory. */
export class FakePlatformAccessory {
  readonly _associatedHAPAccessory: hap.Accessory;
  context: Record<string, unknown> = {};

  constructor(
    readonly displayName: string,
    readonly UUID: string,
    public category?: hap.Categories,
  ) {
    this._associatedHAPAccessory = new hap.Accessory(displayName, UUID);
    if (category !== undefined) this._associatedHAPAccessory.category = category;
  }

  get services(): Service[] {
    return this._associatedHAPAccessory.services;
  }

  addService(...args: Parameters<hap.Accessory['addService']>): Service {
    return this._associatedHAPAccessory.addService(...args);
  }

  getService(name: Parameters<hap.Accessory['getService']>[0]): Service | undefined {
    return this._associatedHAPAccessory.getService(name);
  }

  getServiceById(...args: Parameters<hap.Accessory['getServiceById']>): Service | undefined {
    return this._associatedHAPAccessory.getServiceById(...args);
  }
}

export class FakeHomebridgeApi extends EventEmitter {
  readonly hap = hap;
  readonly platformAccessory = FakePlatformAccessory;
  readonly version = 2.7;
  readonly serverVersion = '2.4.0';
  readonly platforms: { name: string; constructor: new (...args: unknown[]) => unknown }[] = [];
  readonly published: { plugin: string; accessories: FakePlatformAccessory[] }[] = [];
  readonly user: { storagePath: () => string; configPath: () => string };

  constructor(storagePath: string) {
    super();
    this.user = {
      storagePath: () => storagePath,
      configPath: () => path.join(storagePath, 'config.json'),
    };
  }

  async writeHomebridgeConfig(config: unknown): Promise<void> {
    await writeFile(this.user.configPath(), JSON.stringify(config));
  }

  registerPlatform(name: string, constructor: new (...args: unknown[]) => unknown): void {
    this.platforms.push({ name, constructor });
  }

  publishExternalAccessories(plugin: string, accessories: FakePlatformAccessory[]): void {
    this.published.push({ plugin, accessories });
  }

  registerPlatformAccessories(): void {
    throw new Error('the plugin has no bridged accessories');
  }

  unregisterPlatformAccessories(): void {}

  updatePlatformAccessories(): void {}

  versionGreaterOrEqual(): boolean {
    return true;
  }
}
