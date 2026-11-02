import * as hap from '@homebridge/hap-nodejs';
import type { Characteristic, Service } from '@homebridge/hap-nodejs';
import { afterEach, describe, expect, it } from 'vitest';
import plugin from '../src/index';
import { DEVICE_ID, installAppleTv } from './support/apple-tv';
import { FakeBridge, NO_RESPONSE } from './support/fake-bridge';
import { FakeHomebridgeApi, type FakePlatformAccessory } from './support/fake-homebridge';
import { eventually, makeStorage, RecordingLogger, removeTempDirs, seedPairedDevice } from './support/harness';

const { Characteristic: C, Service: S } = hap;

const shutdowns: FakeHomebridgeApi[] = [];
afterEach(async () => {
  for (const api of shutdowns.splice(0)) api.emit('shutdown');
  await new Promise((resolve) => setTimeout(resolve, 50));
  await removeTempDirs();
});

interface Booted {
  api: FakeHomebridgeApi;
  bridge: FakeBridge;
  tv: ReturnType<typeof installAppleTv>;
  log: RecordingLogger;
  platform: unknown;
}

async function boot(config: Record<string, unknown> = {}, options: { paired?: boolean; launch?: boolean } = {}): Promise<Booted> {
  const storagePath = await makeStorage();
  if (options.paired !== false) await seedPairedDevice(storagePath);
  const api = new FakeHomebridgeApi(storagePath);
  await api.writeHomebridgeConfig({ bridge: { name: 'Homebridge', pin: '031-45-154' }, platforms: [] });
  const bridge = new FakeBridge();
  const tv = installAppleTv(bridge);
  const log = new RecordingLogger();
  (plugin as (api: unknown, overrides: unknown) => void)(api, {
    spawnBridge: bridge.spawn,
    env: { ...process.env, AGENT_ATV_FAKE_BRIDGE: '1' },
    hostname: 'testhost',
  });
  const registered = api.platforms[0]!;
  const platform = new registered.constructor(
    log,
    { platform: 'AgentATV', api: { port: 0, bind: '127.0.0.1', token: 'x'.repeat(40) }, discovery: { enabled: false }, ...config },
    api,
  );
  shutdowns.push(api);
  if (options.launch !== false) api.emit('didFinishLaunching');
  return { api, bridge, tv, log, platform };
}

async function publishedTv(api: FakeHomebridgeApi): Promise<FakePlatformAccessory> {
  await eventually(() => api.published.length > 0);
  return api.published[0]!.accessories[0]!;
}

const service = (accessory: FakePlatformAccessory, type: Parameters<FakePlatformAccessory['getService']>[0]): Service => {
  const found = accessory.getService(type);
  if (!found) throw new Error(`no ${String(type)} service`);
  return found;
};

const char = (svc: Service, type: Parameters<Service['getCharacteristic']>[0]): Characteristic => svc.getCharacteristic(type)!;

describe('Homebridge platform (P3)', () => {
  it('registers the AgentATV dynamic platform and starts nothing before didFinishLaunching', async () => {
    const { api, bridge, platform } = await boot({}, { launch: false });

    expect(api.platforms.map((p) => p.name)).toEqual(['AgentATV']);
    expect(typeof (platform as { configureAccessory: unknown }).configureAccessory).toBe('function');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridge.spawns).toEqual([]);

    api.emit('didFinishLaunching');
    await eventually(() => bridge.spawns.length === 1);
  });

  it('logs an invalid config without throwing and starts nothing', async () => {
    const { bridge, log } = await boot({ api: { port: 'eighty' } });

    await eventually(() => log.at('error').length > 0);
    expect(log.at('error').join('\n')).toMatch(/api\.port/);
    expect(bridge.spawns).toEqual([]);
  });

  it('publishes one external Television accessory per paired device after it connects', async () => {
    const { api, log } = await boot();

    const accessory = await publishedTv(api);

    expect(api.published).toHaveLength(1);
    expect(api.published[0]!.plugin).toBe('homebridge-agent-atv');
    expect(accessory.UUID).toBe(hap.uuid.generate(`agent-atv:${DEVICE_ID}`));
    expect(accessory.category).toBe((hap as unknown as { Categories: Record<string, number> }).Categories.APPLE_TV);
    const television = service(accessory, S.Television);
    expect(char(television, C.ConfiguredName).value).toBe('Living Room');
    expect(char(television, C.SleepDiscoveryMode).value).toBe(C.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);
    expect(char(television, C.Active).value).toBe(C.Active.ACTIVE);

    const inputs = accessory.services.filter((s) => s.UUID === S.InputSource.UUID);
    expect(inputs.map((s) => [char(s, C.Identifier).value, char(s, C.ConfiguredName).value])).toEqual([
      [1, 'Netflix'],
      [2, 'Search'],
      [3, 'Settings'],
      [4, 'TV'],
      [5, 'YouTube'],
    ]);
    for (const input of inputs) {
      expect(char(input, C.InputSourceType).value).toBe(C.InputSourceType.APPLICATION);
      expect(char(input, C.IsConfigured).value).toBe(C.IsConfigured.CONFIGURED);
      expect(char(input, C.CurrentVisibilityState).value).toBe(C.CurrentVisibilityState.SHOWN);
    }
    expect(television.linkedServices).toEqual(expect.arrayContaining(inputs));
    expect(char(television, C.ActiveIdentifier).value).toBe(4);

    const speaker = service(accessory, S.TelevisionSpeaker);
    expect(char(speaker, C.VolumeControlType).value).toBe(C.VolumeControlType.RELATIVE);
    expect(television.linkedServices).toContain(speaker);
    expect(log.text).toContain('031-45-154');
  });

  it('limits inputs to homekit.inputs, or to homekit.maxInputs apps by name', async () => {
    const chosen = await boot({ homekit: { inputs: ['com.google.ios.youtube', 'com.netflix.Netflix'] } });
    const a = await publishedTv(chosen.api);
    expect(a.services.filter((s) => s.UUID === S.InputSource.UUID).map((s) => char(s, C.ConfiguredName).value)).toEqual([
      'YouTube',
      'Netflix',
    ]);

    const capped = await boot({ homekit: { maxInputs: 2 } });
    const b = await publishedTv(capped.api);
    expect(b.services.filter((s) => s.UUID === S.InputSource.UUID).map((s) => char(s, C.ConfiguredName).value)).toEqual([
      'Netflix',
      'Search',
    ]);
  });

  it.each([
    [{ homekit: { enabled: false } }],
    [{ devices: [{ id: DEVICE_ID, homekit: false }] }],
  ])('publishes nothing with %j', async (config) => {
    const { api, bridge } = await boot(config);

    await eventually(() => bridge.calls('connect').length === 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(api.published).toEqual([]);
  });

  it('updates Active from state events and ActiveIdentifier from the now-playing app', async () => {
    const { api, tv } = await boot();
    const television = service(await publishedTv(api), S.Television);

    tv.state.nowPlaying = { bundleId: 'com.netflix.Netflix', name: 'Netflix' };
    tv.push();
    await eventually(() => char(television, C.ActiveIdentifier).value === 1);

    tv.state.nowPlaying = { bundleId: 'com.example.Other', name: 'Other' };
    tv.state.power = 'off';
    tv.push();
    await eventually(() => char(television, C.Active).value === C.Active.INACTIVE);
    expect(char(television, C.ActiveIdentifier).value).toBe(0);
  });

  it('sends Active, ActiveIdentifier, RemoteKey and VolumeSelector writes to the bridge', async () => {
    const { api, bridge } = await boot();
    const accessory = await publishedTv(api);
    const television = service(accessory, S.Television);
    const speaker = service(accessory, S.TelevisionSpeaker);

    await char(television, C.Active).handleSetRequest(C.Active.INACTIVE);
    await char(television, C.ActiveIdentifier).handleSetRequest(5);
    for (const key of [C.RemoteKey.ARROW_UP, C.RemoteKey.SELECT, C.RemoteKey.BACK, C.RemoteKey.EXIT, C.RemoteKey.PLAY_PAUSE, C.RemoteKey.INFORMATION]) {
      await char(television, C.RemoteKey).handleSetRequest(key);
    }
    await char(speaker, C.VolumeSelector).handleSetRequest(C.VolumeSelector.INCREMENT);
    await char(speaker, C.VolumeSelector).handleSetRequest(C.VolumeSelector.DECREMENT);

    expect(bridge.calls('power.set')).toEqual([{ device: DEVICE_ID, on: false }]);
    expect(bridge.calls('app.launch')).toEqual([{ device: DEVICE_ID, target: 'com.google.ios.youtube' }]);
    expect(bridge.calls('key').map((p) => p.key)).toEqual([
      'up',
      'select',
      'menu',
      'home',
      'play_pause',
      'top_menu',
      'volume_up',
      'volume_down',
    ]);
  });

  it('answers onGet from the cache without waiting for the bridge', async () => {
    const { api, bridge } = await boot();
    const television = service(await publishedTv(api), S.Television);
    for (const method of ['state', 'power.set', 'key', 'apps.list']) bridge.handle(method, () => NO_RESPONSE);

    const started = Date.now();
    const values = await Promise.all([
      char(television, C.Active).handleGetRequest(),
      char(television, C.ActiveIdentifier).handleGetRequest(),
    ]);

    expect(values).toEqual([C.Active.ACTIVE, 4]);
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('stops the bridge on shutdown', async () => {
    const { api, bridge } = await boot();
    await publishedTv(api);

    api.emit('shutdown');

    await eventually(() => bridge.calls('shutdown').length === 1);
    await eventually(() => !bridge.running);
  });
});
