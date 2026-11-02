export const NETFLIX_REPORT = { available: true, kind: 'app', bundleId: 'com.netflix.Netflix', name: 'Netflix' };
export const SCREEN_OFF = {
  available: false,
  code: 'SCREEN_NOT_CONFIGURED',
  reason: 'screen reading off',
  hint: 'enable "Screen reading" in the agent-atv plugin settings',
};

export const TOKEN = 'test-token-0123456789abcdefghijklmnopqrstuvwxyz-WXYZ';

export function livingRoomState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    device: {
      id: 'A1B2C3D4E5F6',
      name: 'Living Room',
      model: 'Apple TV 4K (gen 3)',
      os: 'tvOS',
      version: '27.2',
      address: '192.168.1.50',
      mac: 'A1:B2:C3:D4:E5:F6',
    },
    power: 'on',
    nowPlaying: { bundleId: 'com.netflix.Netflix', name: 'Netflix' },
    app: NETFLIX_REPORT,
    playing: {
      state: 'playing',
      mediaType: 'video',
      title: 'Chapter One',
      artist: null,
      album: null,
      seriesName: 'Stranger Things',
      season: 4,
      episode: 1,
      position: 723,
      totalTime: 3490,
    },
    keyboard: { focus: 'unfocused', text: null },
    volume: 35,
    protocols: { companion: true, airplay: true },
    seq: 182,
    changedAt: '2026-11-01T15:04:05.123Z',
    connection: 'connected',
    needsPairing: false,
    ...overrides,
  };
}

export const IDLE_PLAYING = {
  state: 'idle',
  mediaType: 'unknown',
  title: null,
  artist: null,
  album: null,
  seriesName: null,
  season: null,
  episode: null,
  position: null,
  totalTime: null,
};

export function apiError(code: string, message: string, hint: string, details: Record<string, unknown> = {}) {
  return { error: { code, message, hint, details } };
}

export const FOCUS = { label: 'Swipe up for full screen', value: null, identifier: 'top-shelf/swipe-up-affordance/arrow' };
export const FOCUS_LINE = 'Focus: "Swipe up for full screen" (id top-shelf/swipe-up-affordance/arrow)';

export function focusReport(element: Record<string, unknown> | null = FOCUS): Record<string, unknown> {
  return { available: true, element };
}

export const NOT_PAIRED_FOCUS = {
  available: false,
  code: 'SCREEN_NOT_PAIRED',
  reason: 'screen reading not paired',
  hint: 'run agent-atv pair A1B2C3D4E5F6 --screen',
};
export const NOT_PAIRED_LINE = 'Focus: unavailable, screen reading not paired: run agent-atv pair A1B2C3D4E5F6 --screen';
