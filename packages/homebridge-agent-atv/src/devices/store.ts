import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { App } from '../bridge/protocol';
import { writeFileAtomic } from '../fs-util';
import { errorMessage, type Logger } from '../logger';

export interface Credentials {
  companion?: string;
  airplay?: string;
}

/** `devices/<id>.json` (DESIGN.md §5.4). */
export interface DeviceRecord {
  id: string;
  name: string;
  address: string | null;
  mac: string | null;
  model: string | null;
  version: string | null;
  credentials: Credentials;
  pairedAt: string | null;
  apps?: { fetchedAt: string; list: App[] };
  /** The pymobiledevice3 RemotePairing record of this Apple TV (screen reading, DESIGN.md §6). */
  remotePairing?: { identifier: string };
}

const SAFE_ID = /^[A-Za-z0-9:._-]+$/;

export class DeviceStore {
  constructor(
    private readonly dir: string,
    private readonly log: Logger,
  ) {}

  async loadAll(): Promise<DeviceRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records: DeviceRecord[] = [];
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      const file = path.join(this.dir, name);
      try {
        const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<DeviceRecord>;
        if (typeof raw.id !== 'string' || raw.id === '') throw new Error('no id');
        records.push({
          id: raw.id.toUpperCase(),
          name: typeof raw.name === 'string' ? raw.name : raw.id,
          address: raw.address ?? null,
          mac: raw.mac ?? null,
          model: raw.model ?? null,
          version: raw.version ?? null,
          credentials: raw.credentials ?? {},
          pairedAt: raw.pairedAt ?? null,
          ...(raw.apps ? { apps: raw.apps } : {}),
          ...(typeof raw.remotePairing?.identifier === 'string' ? { remotePairing: { identifier: raw.remotePairing.identifier } } : {}),
        });
      } catch (error) {
        this.log.error(`Ignoring unreadable device file ${file}: ${errorMessage(error)}`);
      }
    }
    return records;
  }

  async save(record: DeviceRecord): Promise<void> {
    await writeFileAtomic(this.fileFor(record.id), `${JSON.stringify(record, null, 2)}\n`);
  }

  async remove(id: string): Promise<void> {
    await rm(this.fileFor(id), { force: true });
  }

  private fileFor(id: string): string {
    if (!SAFE_ID.test(id)) throw new Error(`Unsafe device id ${id}`);
    return path.join(this.dir, `${id}.json`);
  }
}
