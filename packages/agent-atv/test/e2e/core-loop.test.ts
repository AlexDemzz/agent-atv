import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSandbox, type CliResult, type Sandbox } from '../support/run-cli.js';

const STANDALONE = fileURLToPath(new URL('../../../homebridge-agent-atv/dist/standalone.js', import.meta.url));
const TOKEN = 'e2e-token-0123456789abcdefghijklmnopqrstuvwxyz';
const DEVICE = 'FAKE00000001';

let sandbox: Sandbox;
let plugin: ChildProcess | undefined;
let pluginLog = '';

async function startPlugin(storage: string): Promise<string> {
  const configPath = join(storage, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      platform: 'AgentATV',
      api: { port: 0, bind: '127.0.0.1', token: TOKEN },
      homekit: { enabled: false },
      screen: { enabled: true },
    }),
  );
  const child = spawn(process.execPath, [STANDALONE, '--config', configPath, '--storage', storage], {
    env: { ...process.env, AGENT_ATV_FAKE_BRIDGE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  plugin = child;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`standalone did not start:\n${pluginLog}`)), 30000);
    const onData = (chunk: Buffer): void => {
      pluginLog += chunk.toString('utf8');
      const match = /listening on (http:\/\/\S+)/.exec(pluginLog);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(match[1].replace(/\/+$/, ''));
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`standalone exited with ${code}:\n${pluginLog}`));
    });
  });
}

async function cli(...args: string[]): Promise<CliResult> {
  return sandbox.run(args);
}

async function until(args: string[], accept: (result: CliResult) => boolean, timeoutMs = 20000): Promise<CliResult> {
  const deadline = Date.now() + timeoutMs;
  let last = await cli(...args);
  while (!accept(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    last = await cli(...args);
  }
  return last;
}

function expectOk(result: CliResult): void {
  expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
}

describe.skipIf(process.env.AGENT_ATV_E2E !== '1')('e2e: CLI -> standalone plugin -> fake bridge and screen worker', () => {
  beforeAll(async () => {
    if (!existsSync(STANDALONE)) throw new Error(`Build the plugin first: ${STANDALONE} is missing`);
    sandbox = createSandbox({ AGENT_ATV_TOKEN: TOKEN });
    const url = await startPlugin(sandbox.root);
    sandbox.env.AGENT_ATV_URL = url;
  }, 40000);

  afterAll(async () => {
    if (plugin && plugin.exitCode === null) {
      const exited = new Promise((resolve) => plugin?.once('exit', resolve));
      plugin.kill('SIGTERM');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 7000))]);
      if (plugin.exitCode === null) plugin.kill('SIGKILL');
    }
    sandbox?.cleanup();
  });

  it('runs the core loop: pair, snapshot, open, wait, fill, press, state, focus, screenshot', async () => {
    const discovered = await until(['devices'], (result) => result.stdout.includes(DEVICE));
    expect(discovered.stdout).toContain(`${DEVICE}  Fake Apple TV`);

    // No device given: before anything is paired, `default` is the only known Apple TV.
    const started = await cli('pair', '--no-input');
    expectOk(started);
    const pairingId = /pairing (p-[0-9a-f]{12}) started \(step 1\/3, companion\)/.exec(started.stdout)?.[1];
    expect(pairingId, started.stdout).toBeDefined();

    // The fake rejects the Companion credentials for AirPlay, so the plugin asks for a second PIN.
    const companion = await cli('pair', '--pairing', pairingId as string, '--pin', '1234');
    expectOk(companion);
    expect(companion.stdout).toContain(`pairing ${pairingId} started (step 2/3, airplay)`);

    const airplay = await cli('pair', '--pairing', pairingId as string, '--pin', '1234');
    expectOk(airplay);
    expect(airplay.stdout).toContain(`pairing ${pairingId} started (step 3/3, remotepairing)`);

    const remotePairing = await cli('pair', '--pairing', pairingId as string, '--pin', '1234');
    expectOk(remotePairing);
    expect(remotePairing.stdout).toBe(`paired Fake Apple TV (${DEVICE})\n`);

    const connected = await until(['state', 'connection'], (result) => result.stdout === 'connected\n');
    expect(connected.stdout).toBe('connected\n');

    const snapshot = await cli('snapshot');
    expectOk(snapshot);
    expect(snapshot.stdout).toContain(`Device: Fake Apple TV (${DEVICE}) tvOS 27.2, connected`);
    // The fake worker's Apple TV always shows the home screen.
    expect(snapshot.stdout).toContain('App: Home screen');
    expect(snapshot.stdout).toContain('Playing: idle');
    expect(snapshot.stdout).toContain('Volume: 50');
    expect(snapshot.stdout).toContain('Focus: "Fake focus" (id fake/focus)\n');

    const opened = await cli('open', 'Search', '--no-wait');
    expectOk(opened);
    expect(opened.stdout).toBe('launched com.apple.TVSearch\n');

    expectOk(await cli('wait', '--keyboard', '--timeout', '5000'));

    const filled = await cli('fill', 'stranger things', '--settle');
    expectOk(filled);
    expect(filled.stdout).toBe('keyboard: "stranger things"\nFocus: "Fake focus" (id fake/focus)\n');
    expect((await cli('state', 'keyboard')).stdout).toBe('focused "stranger things"\n');

    const pressed = await cli('press', 'home', '--settle');
    expectOk(pressed);
    expect(pressed.stdout).toBe('pressed home\nFocus: "Fake focus" (id fake/focus)\n');
    expectOk(await cli('wait', '--no-keyboard', '--timeout', '5000'));
    expect((await cli('state', 'app')).stdout).toBe('home screen\n');

    const played = await cli('press', 'play_pause');
    expectOk(played);
    expect(played.stdout).toBe('pressed play_pause\n');
    const playing = await cli('wait', '--playing', '--text', 'fake movie', '--timeout', '5000');
    expectOk(playing);
    expect(playing.stdout).toMatch(/^ok playback text \(\d+ms\)\n$/);
    expect((await cli('state', 'playing')).stdout).toMatch(/^playing video "Fake Movie" \d+:\d{2}\/1:30:00 in TV\n$/);

    const volume = await cli('volume', 'up', '--step', '2');
    expectOk(volume);
    expect((await until(['state', 'volume'], (result) => result.stdout === '60\n')).stdout).toBe('60\n');

    const notFocused = await cli('fill', 'nope');
    expect(notFocused.code).toBe(6);
    expect(notFocused.stderr).toContain('(KEYBOARD_NOT_FOCUSED)');

    const timeout = await cli('wait', '--paused', '--timeout', '500');
    expect(timeout.code).toBe(7);
    expect(timeout.stderr).toContain('hint: Current state: playing video "Fake Movie"');

    expect((await cli('state', 'focus')).stdout).toBe('"Fake focus" (id fake/focus)\n');
    const focused = await cli('wait', '--focus', 'fake', '--timeout', '5000');
    expectOk(focused);
    expect(focused.stdout).toMatch(/^ok focus \(\d+ms\)\nFocus: "Fake focus" \(id fake\/focus\)\n$/);

    const shot = await cli('screenshot', join(sandbox.root, 'tv.png'));
    expectOk(shot);
    expect(shot.stdout).toMatch(/tv\.png \(1920x1080, \d+\.\ds\)\n$/);

    const doctor = await cli('doctor');
    expect(doctor.code, doctor.stdout).toBe(0);
    expect(doctor.stdout).toContain('ok bridge: ready (fake backend');
    expect(doctor.stdout).toMatch(/^ok screen: connected/m);
  }, 120000);
});
