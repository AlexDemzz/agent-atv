import { usageError } from './errors.js';

const MULTI_ACTION_KEYS = ['up', 'down', 'left', 'right', 'select', 'menu', 'home'];
const TAP_ONLY_KEYS = [
  'home_hold', 'top_menu', 'play', 'pause', 'play_pause', 'stop', 'next', 'previous',
  'volume_up', 'volume_down', 'channel_up', 'channel_down', 'screensaver', 'guide',
  'control_center', 'skip_forward', 'skip_backward',
];
export const KEY_NAMES = [...MULTI_ACTION_KEYS, ...TAP_ONLY_KEYS];

const ALIASES: Record<string, string> = {
  enter: 'select', ok: 'select', return: 'select', click: 'select',
  back: 'menu', escape: 'menu', esc: 'menu',
  arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right',
  tv: 'home',
  playpause: 'play_pause', space: 'play_pause',
  volup: 'volume_up', voldown: 'volume_down',
  ff: 'skip_forward', rw: 'skip_backward',
};

export type KeyAction = 'tap' | 'double' | 'hold';
const ACTIONS: KeyAction[] = ['tap', 'double', 'hold'];

export interface KeyPress {
  key: string;
  action: KeyAction;
  count: number;
}

export function resolveKey(name: string): string {
  const lower = name.toLowerCase();
  const key = ALIASES[lower] ?? lower.replaceAll('-', '_');
  if (!KEY_NAMES.includes(key)) {
    throw usageError(`Unknown key "${name}"`, `Valid keys: ${KEY_NAMES.join(' ')}`);
  }
  return key;
}

/** Parses `<key>[:<action>][*<count>]`; `defaultAction` applies when the spec has no action. */
export function parseKeySpec(spec: string, defaultAction: KeyAction = 'tap'): KeyPress {
  const match = /^([^:*]+)(?::([^*]*))?(?:\*(.*))?$/.exec(spec);
  if (!match) throw usageError(`Invalid key spec "${spec}"`, 'Use <key>[:tap|double|hold][*count], e.g. down*3 or select:hold');
  const [, name = '', actionText, countText] = match;
  const key = resolveKey(name);

  const action = (actionText?.toLowerCase() ?? defaultAction) as KeyAction;
  if (!ACTIONS.includes(action)) {
    throw usageError(`Invalid action "${actionText}" in "${spec}"`, 'Actions: tap, double, hold');
  }
  if (action !== 'tap' && !MULTI_ACTION_KEYS.includes(key)) {
    throw usageError(`Key ${key} supports only tap`, `double and hold work with: ${MULTI_ACTION_KEYS.join(' ')}`);
  }

  let count = 1;
  if (countText !== undefined) {
    count = /^\d+$/.test(countText) ? Number(countText) : NaN;
    if (!(count >= 1 && count <= 50)) throw usageError(`Invalid count in "${spec}"`, 'Count must be 1-50, e.g. down*3');
  }
  return { key, action, count };
}

export function formatKeyPress(press: KeyPress): string {
  return `${press.key}${press.action === 'tap' ? '' : `:${press.action}`}${press.count > 1 ? `*${press.count}` : ''}`;
}
