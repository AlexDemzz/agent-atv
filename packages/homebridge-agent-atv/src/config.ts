export interface DeviceConfig {
  id: string;
  name?: string;
  address?: string;
  homekit: boolean;
}

export interface AgentAtvConfig {
  name: string;
  api: { port: number; bind: string; token: string };
  discovery: { enabled: boolean; hosts: string[] };
  devices: DeviceConfig[];
  homekit: { enabled: boolean; inputs: string[]; maxInputs: number };
  screen: { enabled: boolean };
  python: { executable: string; forceVenvRecreate: boolean };
  debug: boolean;
}

export type ConfigResult = { ok: true; config: AgentAtvConfig } | { ok: false; errors: string[] };

type Raw = Record<string, unknown>;

const isObject = (value: unknown): value is Raw =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

class Reader {
  readonly errors: string[] = [];

  section(raw: Raw, key: string): Raw {
    const value = raw[key];
    if (value === undefined || value === null) return {};
    if (isObject(value)) return value;
    this.errors.push(`${key} must be an object`);
    return {};
  }

  string(raw: Raw, key: string, path: string, fallback: string): string {
    const value = raw[key];
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'string') return value;
    this.errors.push(`${path} must be a string`);
    return fallback;
  }

  optionalString(raw: Raw, key: string, path: string): string | undefined {
    const value = this.string(raw, key, path, '');
    return value === '' ? undefined : value;
  }

  boolean(raw: Raw, key: string, path: string, fallback: boolean): boolean {
    const value = raw[key];
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    this.errors.push(`${path} must be true or false`);
    return fallback;
  }

  integer(raw: Raw, key: string, path: string, fallback: number, accepts: (n: number) => boolean, range: string): number {
    const value = raw[key];
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'number' && Number.isInteger(value) && accepts(value)) return value;
    this.errors.push(`${path} must be an integer ${range}`);
    return fallback;
  }

  strings(raw: Raw, key: string, path: string): string[] {
    const value = raw[key];
    if (value === undefined || value === null) return [];
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      return value.map((item) => item.trim()).filter((item) => item !== '');
    }
    this.errors.push(`${path} must be a list of strings`);
    return [];
  }
}

const between = (min: number, max: number) => (n: number) => n >= min && n <= max;

/** Applies DESIGN.md §5.1 defaults to a raw platform config block and validates it. */
export function parseConfig(input: unknown): ConfigResult {
  const reader = new Reader();
  const raw = isObject(input) ? input : {};
  if (!isObject(input) && input !== undefined && input !== null) reader.errors.push('the platform config must be an object');

  const api = reader.section(raw, 'api');
  const discovery = reader.section(raw, 'discovery');
  const homekit = reader.section(raw, 'homekit');
  const screen = reader.section(raw, 'screen');
  const python = reader.section(raw, 'python');

  const devices: DeviceConfig[] = [];
  const rawDevices = raw.devices;
  if (rawDevices !== undefined && rawDevices !== null) {
    if (!Array.isArray(rawDevices)) {
      reader.errors.push('devices must be a list');
    } else {
      rawDevices.forEach((entry: unknown, index) => {
        const path = `devices[${index}]`;
        if (!isObject(entry)) {
          reader.errors.push(`${path} must be an object`);
          return;
        }
        const id = reader.string(entry, 'id', `${path}.id`, '').trim();
        if (id === '') {
          reader.errors.push(`${path}.id is required`);
          return;
        }
        const device: DeviceConfig = { id, homekit: reader.boolean(entry, 'homekit', `${path}.homekit`, true) };
        const name = reader.optionalString(entry, 'name', `${path}.name`);
        const address = reader.optionalString(entry, 'address', `${path}.address`);
        if (name !== undefined) device.name = name;
        if (address !== undefined) device.address = address;
        devices.push(device);
      });
    }
  }

  const config: AgentAtvConfig = {
    name: reader.string(raw, 'name', 'name', 'Agent ATV') || 'Agent ATV',
    api: {
      port: reader.integer(api, 'port', 'api.port', 8787, (n) => n === 0 || between(1024, 65535)(n), 'between 1024 and 65535'),
      bind: reader.string(api, 'bind', 'api.bind', '0.0.0.0').trim() || '0.0.0.0',
      token: reader.string(api, 'token', 'api.token', '').trim(),
    },
    discovery: {
      enabled: reader.boolean(discovery, 'enabled', 'discovery.enabled', true),
      hosts: reader.strings(discovery, 'hosts', 'discovery.hosts'),
    },
    devices,
    homekit: {
      enabled: reader.boolean(homekit, 'enabled', 'homekit.enabled', true),
      inputs: reader.strings(homekit, 'inputs', 'homekit.inputs'),
      maxInputs: reader.integer(homekit, 'maxInputs', 'homekit.maxInputs', 12, between(1, 40), 'between 1 and 40'),
    },
    screen: { enabled: reader.boolean(screen, 'enabled', 'screen.enabled', false) },
    python: {
      executable: reader.string(python, 'executable', 'python.executable', 'python3').trim() || 'python3',
      forceVenvRecreate: reader.boolean(python, 'forceVenvRecreate', 'python.forceVenvRecreate', false),
    },
    debug: reader.boolean(raw, 'debug', 'debug', false),
  };

  return reader.errors.length > 0 ? { ok: false, errors: reader.errors } : { ok: true, config };
}
