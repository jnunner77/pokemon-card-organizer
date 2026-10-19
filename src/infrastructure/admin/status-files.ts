import fs from 'node:fs';
import path from 'node:path';
import type { OffsiteRecord, StatusFile } from '#application/admin/ports.ts';
import { type OffsiteCopy, offsiteCopyFrom } from '#domain/admin/offsite.ts';

// The files the server and its nightly job (Boards' deploy/ops/nightly.sh) leave each other in the
// data directory: status.txt from the server, which the job reads with `docker compose exec binder
// cat /data/status.txt` and alerts on; offsite.json from the job, after it copied a backup off the server.

export const STATUS_FILE = 'status.txt';
export const OFFSITE_FILE = 'offsite.json';

export class FileStatusFile implements StatusFile {
  readonly #file: string;

  constructor(dataDir: string) {
    this.#file = path.join(dataDir, STATUS_FILE);
  }

  async write(text: string): Promise<void> {
    await fs.promises.writeFile(`${this.#file}.tmp`, text);
    await fs.promises.rename(`${this.#file}.tmp`, this.#file);
  }
}

export class FileOffsiteRecord implements OffsiteRecord {
  readonly #file: string;

  constructor(dataDir: string) {
    this.#file = path.join(dataDir, OFFSITE_FILE);
  }

  /** The nightly job's last copy off the server, if it has made one (and the file is readable). */
  async latest(): Promise<OffsiteCopy | null> {
    try {
      return offsiteCopyFrom(JSON.parse(await fs.promises.readFile(this.#file, 'utf8')));
    } catch {
      return null;
    }
  }
}
