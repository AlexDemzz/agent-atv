import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { createAgentAtvCore, readPluginVersion, type AgentAtvCore, type CoreOptions } from './core';
import { TelevisionAccessories } from './homekit/television';
import { errorMessage } from './logger';

/** Test and development hooks; Homebridge never passes them. */
export type PlatformOverrides = Pick<CoreOptions, 'spawnBridge' | 'env' | 'hostname'>;

export class AgentAtvPlatform implements DynamicPlatformPlugin {
  private readonly core: AgentAtvCore;

  constructor(
    private readonly log: Logging,
    config: PlatformConfig,
    private readonly api: API,
    overrides: PlatformOverrides = {},
  ) {
    this.core = createAgentAtvCore({
      config,
      storagePath: api.user.storagePath(),
      log,
      pluginVersion: readPluginVersion(),
      ...overrides,
    });
    api.on('didFinishLaunching', () => {
      this.start().catch((error: unknown) => log.error(`agent-atv failed to start: ${errorMessage(error)}`));
    });
    api.on('shutdown', () => {
      this.core.stop().catch((error: unknown) => log.error(`agent-atv failed to stop cleanly: ${errorMessage(error)}`));
    });
  }

  /** There are no bridged accessories; cached ones are dropped. */
  configureAccessory(_accessory: PlatformAccessory): void {}

  private async start(): Promise<void> {
    await this.core.start();
    const { config, devices } = this.core;
    if (!config || !devices) return;
    new TelevisionAccessories({ api: this.api, devices, config, log: this.log }).start();
  }
}
