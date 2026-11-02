import type { API, Logging, PlatformConfig } from 'homebridge';
import { AgentAtvPlatform, type PlatformOverrides } from './platform';
import { PLATFORM_NAME } from './settings';

export default (api: API, overrides?: PlatformOverrides): void => {
  if (!overrides) {
    api.registerPlatform(PLATFORM_NAME, AgentAtvPlatform);
    return;
  }
  api.registerPlatform(
    PLATFORM_NAME,
    class extends AgentAtvPlatform {
      constructor(log: Logging, config: PlatformConfig, homebridgeApi: API) {
        super(log, config, homebridgeApi, overrides);
      }
    },
  );
};
