import { BridgeError } from '../bridge/client';
import { errorMessage } from '../logger';

export type Details = Record<string, unknown>;

export const ACCESS_DENIED_HINT =
  'In the Home app, open Home Settings > Speakers & TVs and allow "Everyone" or "Anyone on the Same Network" (no password), and on the Apple TV set Settings > AirPlay and HomeKit > Allow Access accordingly, then retry.';

const TABLE: Record<string, { status: number; hint: string }> = {
  BAD_REQUEST: { status: 400, hint: 'Fix the request and retry. See: agent-atv --help' },
  UNAUTHORIZED: {
    status: 401,
    hint: 'Set the API token shown in the plugin settings UI with: agent-atv config set token -',
  },
  ROUTE_NOT_FOUND: { status: 404, hint: 'Update agent-atv and the plugin to matching versions. Check with: agent-atv doctor' },
  DEVICE_NOT_FOUND: { status: 404, hint: 'List the known Apple TVs with: agent-atv devices (or agent-atv scan)' },
  PAIRING_NOT_FOUND: { status: 404, hint: 'Start a new pairing with: agent-atv pair' },
  APP_NOT_FOUND: { status: 404, hint: 'List the installed apps with: agent-atv apps' },
  WAIT_TIMEOUT: { status: 408, hint: 'Run agent-atv snapshot to see where you are.' },
  NOT_PAIRED: { status: 409, hint: 'Pair the Apple TV with: agent-atv pair' },
  AMBIGUOUS_DEVICE: { status: 409, hint: 'Pick a device with --device <id|name>; list them with: agent-atv devices' },
  AMBIGUOUS_APP: { status: 409, hint: 'Use the exact name or the bundle id; list them with: agent-atv apps' },
  PAIRING_IN_PROGRESS: {
    status: 409,
    hint: 'Finish it with agent-atv pair --pairing <pairingId> --pin <PIN>, or cancel it with agent-atv pair --cancel <pairingId>.',
  },
  KEYBOARD_NOT_FOCUSED: {
    status: 409,
    hint: 'Navigate to a text field and press select, then retry. Check with: agent-atv state keyboard',
  },
  DEVICE_OFF: { status: 409, hint: 'Turn the Apple TV on with: agent-atv power on' },
  FOCUS_UNKNOWN: {
    status: 409,
    hint: 'move the focus with a direction key (agent-atv press down --settle), or look with agent-atv screenshot',
  },
  PAYLOAD_TOO_LARGE: { status: 413, hint: 'Send a smaller request body (64 KiB max).' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, hint: 'Send the body as JSON with Content-Type: application/json.' },
  PAIRING_FAILED: { status: 422, hint: 'Start over with agent-atv pair and type the PIN shown on the TV.' },
  PAIRING_EXPIRED: { status: 422, hint: 'The PIN expired; start over with: agent-atv pair' },
  LAUNCH_FAILED: { status: 422, hint: 'Check the app is installed with: agent-atv apps' },
  PAIRING_BACKOFF: { status: 429, hint: 'The Apple TV is refusing pairing for a while; wait and retry agent-atv pair.' },
  INTERNAL: { status: 500, hint: 'Retry; if it persists, ask the user to check the Homebridge log and update the plugin.' },
  NOT_SUPPORTED: { status: 501, hint: 'This Apple TV does not support that; try another way, starting from agent-atv snapshot.' },
  DEVICE_ERROR: { status: 502, hint: 'Retry; if it persists, run agent-atv doctor.' },
  SCREEN_FAILED: { status: 502, hint: 'Retry; if it keeps failing, run agent-atv doctor.' },
  NOT_CONNECTED: { status: 503, hint: 'The plugin is reconnecting; wait and retry, or check with: agent-atv doctor' },
  AUTH_FAILED: { status: 503, hint: 'The Apple TV rejected the credentials; pair again with: agent-atv pair' },
  ACCESS_DENIED: { status: 503, hint: ACCESS_DENIED_HINT },
  BRIDGE_UNAVAILABLE: {
    status: 503,
    hint: 'Wait a few seconds and retry; if it persists, run agent-atv doctor.',
  },
  SCREEN_NOT_CONFIGURED: { status: 503, hint: 'enable "Screen reading" in the agent-atv plugin settings' },
  SCREEN_NOT_PAIRED: { status: 503, hint: 'run agent-atv pair --screen' },
  SCREEN_UNAVAILABLE: { status: 503, hint: 'Retry in a few seconds; if it persists, run agent-atv doctor.' },
  DEVICE_TIMEOUT: { status: 504, hint: 'The Apple TV did not answer in time; retry, or check it is awake with agent-atv snapshot.' },
  POWER_NOT_CONFIRMED: { status: 504, hint: 'Run agent-atv power on again, then check with: agent-atv wait --power on' },
  BRIDGE_TIMEOUT: { status: 504, hint: 'Retry; if it persists, run agent-atv doctor.' },
};

export class ApiError extends Error {
  readonly status: number;
  readonly hint: string;
  readonly headers: Record<string, string>;

  constructor(
    readonly code: string,
    message: string,
    readonly details: Details = {},
    options: { hint?: string; headers?: Record<string, string> } = {},
  ) {
    super(message);
    const entry = TABLE[code] ?? TABLE.INTERNAL!;
    this.status = entry.status;
    this.hint = options.hint ?? entry.hint;
    this.headers = options.headers ?? {};
  }

  toBody(): { error: { code: string; message: string; hint: string; details: Details } } {
    return { error: { code: this.code, message: this.message, hint: this.hint, details: this.details } };
  }
}

export const badRequest = (field: string, message: string): ApiError =>
  new ApiError('BAD_REQUEST', message, { field });

export const isKnownCode = (code: string): boolean => code in TABLE;

/** Maps a bridge failure to the API error of DESIGN.md §3.3. */
export function toApiError(error: unknown, deviceName: string): ApiError {
  if (error instanceof ApiError) return error;
  if (!(error instanceof BridgeError)) {
    return new ApiError('INTERNAL', `Internal error: ${errorMessage(error)}`);
  }
  const details = { ...error.details };
  switch (error.code) {
    case 'UNKNOWN_METHOD':
      return new ApiError('INTERNAL', `The bridge does not know ${String(details.method ?? 'a method')}; update the plugin`, details);
    case 'KEYBOARD_NOT_FOCUSED':
      return new ApiError('KEYBOARD_NOT_FOCUSED', `No text field is focused on ${deviceName}`, details);
    case 'PAIRING_BACKOFF': {
      const retryAfterSec = typeof details.retryAfterSec === 'number' ? details.retryAfterSec : 30;
      return new ApiError('PAIRING_BACKOFF', error.message, { ...details, retryAfterSec }, {
        headers: { 'Retry-After': String(retryAfterSec) },
        hint: `${deviceName} refuses pairing for now; wait ${retryAfterSec}s, then retry agent-atv pair.`,
      });
    }
    case 'POWER_NOT_CONFIRMED': {
      const requested = details.requested === 'off' ? 'off' : 'on';
      return new ApiError('POWER_NOT_CONFIRMED', error.message, details, {
        hint: `Run agent-atv power ${requested} again, then check with: agent-atv wait --power ${requested}`,
      });
    }
    default:
      return new ApiError(error.code, error.message, details);
  }
}
