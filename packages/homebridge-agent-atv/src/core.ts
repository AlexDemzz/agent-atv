import { readFileSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import path from 'node:path';
import { ApiServer } from './api/server';
import { resolveToken } from './api/auth';
import { buildRoutes } from './api/routes';
import { BridgeClient, defaultSpawnBridge, type SpawnBridge } from './bridge/client';
import { parseConfig, type AgentAtvConfig } from './config';
import { DeviceManager } from './devices/manager';
import { DeviceStore } from './devices/store';
import { ensureDir } from './fs-util';
import { errorMessage, withDebug, type Logger } from './logger';
import { PairingManager } from './pairing/manager';
import { ensureVenv, runCommand } from './python/venv';
import { ScreenService } from './screen/service';

export type { SpawnBridge } from './bridge/client';
export type { Logger } from './logger';

export interface CoreOptions {
  /** The raw platform config block, validated by config.ts. */
  config: unknown;
  /** Homebridge storage path; the core uses <storagePath>/agent-atv. */
  storagePath: string;
  log: Logger;
  pluginVersion: string;
  /** Default: child_process.spawn of DESIGN.md §2.1. */
  spawnBridge?: SpawnBridge;
  /** Default: child_process.spawn of a screen worker (DESIGN.md §6.2). */
  spawnScreen?: SpawnBridge;
  /** Default os.hostname(), used in the pairing remote name. */
  hostname?: string;
  /** Default process.env; read for AGENT_ATV_FAKE_BRIDGE and passed to the bridge. */
  env?: NodeJS.ProcessEnv;
  /** Called once the HTTP API listens, before the venv bootstrap and the bridge start. */
  onListening?: (address: { host: string; port: number }) => void;
}

export interface AgentAtvCore {
  start(): Promise<void>;
  stop(): Promise<void>;
  address(): { host: string; port: number } | null;
  /** Null until start() validated the config. */
  readonly config: AgentAtvConfig | null;
  readonly devices: DeviceManager | null;
}

/** The installed npm package directory (src/ and dist/ both sit one level below it). */
export const PLUGIN_PKG_DIR = path.resolve(__dirname, '..');

export function readPluginVersion(): string {
  const pkg = JSON.parse(readFileSync(path.join(PLUGIN_PKG_DIR, 'package.json'), 'utf8')) as { version: string };
  return pkg.version;
}

class Core implements AgentAtvCore {
  config: AgentAtvConfig | null = null;
  devices: DeviceManager | null = null;
  private bridge: BridgeClient | null = null;
  private server: ApiServer | null = null;
  private pairing: PairingManager | null = null;
  private screen: ScreenService | null = null;
  private stopped = false;
  private log: Logger;

  constructor(private readonly options: CoreOptions) {
    this.log = options.log;
  }

  async start(): Promise<void> {
    const parsed = parseConfig(this.options.config);
    if (!parsed.ok) {
      this.log.error(`Invalid agent-atv config, nothing started: ${parsed.errors.join('; ')}`);
      return;
    }
    const config = parsed.config;
    this.config = config;
    const log = withDebug(this.options.log, config.debug);
    this.log = log;
    const env = this.options.env ?? process.env;
    const pluginDir = path.join(this.options.storagePath, 'agent-atv');
    await ensureDir(pluginDir);

    const fake = env.AGENT_ATV_FAKE_BRIDGE === '1';
    const pythonDir = path.join(PLUGIN_PKG_DIR, 'python');
    const bridge = new BridgeClient({
      spawn: this.options.spawnBridge ?? defaultSpawnBridge,
      spec: {
        command: config.python.executable,
        args: ['-u', '-m', 'agent_atv_bridge', ...(fake ? ['--fake'] : [])],
        cwd: pythonDir,
        env: { ...env, PYTHONPATH: pythonDir },
      },
      log,
    });
    this.bridge = bridge;

    const store = new DeviceStore(path.join(pluginDir, 'devices'), log);
    const devices = new DeviceManager({ bridge, store, config, log });
    this.devices = devices;
    await devices.load();
    const screen = new ScreenService({
      enabled: config.screen.enabled,
      pluginDir,
      pythonDir,
      devices,
      log,
      env,
      spawn: this.options.spawnScreen ?? defaultSpawnBridge,
      python: config.python.executable,
      fake,
      install: () => this.installScreen(config, pluginDir, pythonDir, fake, log),
    });
    this.screen = screen;
    this.pairing = new PairingManager({
      bridge,
      devices,
      screen,
      log,
      remoteName: `agent-atv (${this.options.hostname ?? osHostname()})`,
    });

    const token = await resolveToken({ configured: config.api.token, pluginDir, log });
    if (token !== null && !this.stopped) {
      const server = new ApiServer({
        routes: buildRoutes({
          version: this.options.pluginVersion,
          bridge,
          devices,
          pairing: this.pairing,
          screen,
          config,
        }),
        token,
        version: this.options.pluginVersion,
        log,
      });
      if (await server.listen(config.api.bind, config.api.port)) {
        if (this.stopped) {
          await server.close();
          return;
        }
        this.server = server;
        const address = server.address();
        if (address) this.options.onListening?.(address);
      }
    }

    let bridgeStartable = true;
    if (!fake) {
      bridge.setInstalling();
      try {
        const venv = await ensureVenv({
          pluginDir,
          python: config.python.executable,
          requirementsPath: path.join(pythonDir, 'requirements.txt'),
          force: config.python.forceVenvRecreate,
          run: runCommand,
          log,
        });
        bridge.setCommand(venv.python);
      } catch (error) {
        bridgeStartable = false;
        bridge.fail(errorMessage(error));
        log.error(`The Python bridge cannot start: ${errorMessage(error)}`);
      }
    }
    if (this.stopped) return;
    if (bridgeStartable) {
      bridge.start();
      await bridge.waitReady();
      if (this.stopped) return;
      devices.startSupervision();
    }
    // After the bridge and in the background, so the screen venv's long first install delays nothing.
    screen.start();
  }

  private async installScreen(config: AgentAtvConfig, pluginDir: string, pythonDir: string, fake: boolean, log: Logger): Promise<string> {
    if (fake) return config.python.executable;
    const venv = await ensureVenv({
      pluginDir,
      venvName: '.venv-screen',
      purpose: 'the screen worker',
      python: config.python.executable,
      requirementsPath: path.join(pythonDir, 'requirements-screen.txt'),
      force: config.python.forceVenvRecreate,
      run: runCommand,
      log,
    });
    return venv.python;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.devices?.stop();
    this.pairing?.stop();
    await Promise.all([
      this.server?.close(),
      this.screen?.stop(),
      this.bridge?.stop().catch((error: unknown) => this.log.error(`Stopping the bridge failed: ${errorMessage(error)}`)),
    ]);
    this.server = null;
  }

  address(): { host: string; port: number } | null {
    return this.server?.address() ?? null;
  }
}

export function createAgentAtvCore(options: CoreOptions): AgentAtvCore {
  return new Core(options);
}
