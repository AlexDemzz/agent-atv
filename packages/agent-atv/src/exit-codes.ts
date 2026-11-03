import type { AtvError } from './errors.js';

export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  unreachable: 3,
  auth: 4,
  notFound: 5,
  notReady: 6,
  waitTimeout: 7,
  screen: 8,
} as const;

const BY_CODE: Record<string, number> = {
  USAGE: EXIT.usage,
  CONFIG_MISSING: EXIT.usage,
  BAD_REQUEST: EXIT.usage,
  CONNECTION_FAILED: EXIT.unreachable,
  TIMEOUT: EXIT.unreachable,
  UNAUTHORIZED: EXIT.auth,
  DEVICE_NOT_FOUND: EXIT.notFound,
  APP_NOT_FOUND: EXIT.notFound,
  PAIRING_NOT_FOUND: EXIT.notFound,
  ROUTE_NOT_FOUND: EXIT.notFound,
  AMBIGUOUS_DEVICE: EXIT.notFound,
  AMBIGUOUS_APP: EXIT.notFound,
  FOCUS_NOT_FOUND: EXIT.notFound,
  NOT_PAIRED: EXIT.notReady,
  NOT_CONNECTED: EXIT.notReady,
  AUTH_FAILED: EXIT.notReady,
  ACCESS_DENIED: EXIT.notReady,
  BRIDGE_UNAVAILABLE: EXIT.notReady,
  DEVICE_OFF: EXIT.notReady,
  KEYBOARD_NOT_FOCUSED: EXIT.notReady,
  WAIT_TIMEOUT: EXIT.waitTimeout,
  SCREEN_NOT_CONFIGURED: EXIT.screen,
  SCREEN_NOT_PAIRED: EXIT.screen,
  SCREEN_UNAVAILABLE: EXIT.screen,
  SCREEN_FAILED: EXIT.screen,
  FOCUS_UNKNOWN: EXIT.screen,
};

export function exitCodeFor(error: AtvError): number {
  return error.exitCode ?? BY_CODE[error.code] ?? EXIT.failed;
}
