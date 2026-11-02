import type { Command } from '../context.js';
import { skills } from '../skills.js';
import { apps } from './apps.js';
import { config } from './config.js';
import { power, seek, volume } from './controls.js';
import { devices, scan } from './devices.js';
import { doctor } from './doctor.js';
import { clear, fill, type } from './keyboard.js';
import { open } from './open.js';
import { pair, unpair } from './pair.js';
import { back, home, press } from './press.js';
import { screenshot } from './screenshot.js';
import { snapshot } from './snapshot.js';
import { state } from './state.js';
import { wait } from './wait.js';

export const COMMANDS: Command[] = [
  snapshot, state, screenshot,
  press, back, home, open, type, fill, clear,
  wait,
  power, volume, seek, apps,
  devices, scan, pair, unpair,
  doctor, skills, config,
];

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((command) => command.name === name);
}
