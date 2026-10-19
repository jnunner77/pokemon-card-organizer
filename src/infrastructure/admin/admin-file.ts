import fs from 'node:fs';
import path from 'node:path';
import type { AdminSettingsStore } from '#application/admin/ports.ts';
import { type AdminSettings, adminSettingsFrom, DEFAULT_ADMIN_SETTINGS } from '#domain/admin/settings.ts';
import { damagedMessage, readJson } from '../json-store/damaged.ts';
import { writePrivate } from '../private-file.ts';

// Settings only administrators change, kept in <data>/admin.json (readable only by the server).
// They live outside db.json so restoring a backup of the ledger never changes how the server
// itself is run.

export class AdminFile implements AdminSettingsStore {
  readonly #file: string;
  #data: AdminSettings;
  /** admin.json was damaged at start and the defaults were used (src/main.ts logs it). */
  readonly recovered: string | null = null;

  /** `defaults`: the starting settings where admin.json says nothing (main.ts: the price schedule from the environment). */
  constructor(dataDir: string, defaults: Partial<AdminSettings> = {}) {
    this.#file = path.join(dataDir, 'admin.json');
    let recovered: string | null = null;
    const saved = readJson<Record<string, unknown>>(this.#file, (d) => (recovered = damagedMessage(d, 'The default settings are used (backup retention, the price update schedule); check them under Administration.')));
    this.recovered = recovered;
    this.#data = adminSettingsFrom(saved, { ...DEFAULT_ADMIN_SETTINGS, ...defaults });
  }

  get(): AdminSettings {
    return structuredClone(this.#data);
  }

  set(patch: Partial<AdminSettings>): AdminSettings {
    this.#data = { ...this.#data, ...patch };
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    writePrivate(this.#file, JSON.stringify(this.#data, null, 2));
    return this.get();
  }
}
