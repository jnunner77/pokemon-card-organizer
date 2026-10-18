import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { Store } from '#infrastructure/json-store/store.ts';

/** A store in a fresh temporary data directory, removed when the test file is done. */
export function tempStore(): Store {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-store-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Store(dir);
}

export const readFile = (store: Store): unknown => JSON.parse(fs.readFileSync(store.file, 'utf8'));
