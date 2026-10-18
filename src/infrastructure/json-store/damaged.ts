import fs from 'node:fs';
import path from 'node:path';

// Saved files that are damaged (cut short by a full disk or a crash mid-write) are set aside so
// the server can start from a good copy or its defaults.

/** A saved file that couldn't be read, and where it was put. */
export interface Damaged {
  file: string;
  /** The damaged file's new name, kept for a person to look at. */
  setAside: string | null;
  error: string;
}

/**
 * Read a JSON file the server saved: null when there is none. A file that can't be parsed (or
 * isn't an object) is renamed to <name>.damaged-<time> and reported through `onDamaged`, then
 * null is returned, so the caller starts from its defaults or a copy. With `keep`, the damaged file
 * stays where it is (the caller sets it aside once it has something better).
 */
export function readJson<T>(file: string, onDamaged: (d: Damaged) => void, o: { keep?: boolean } = {}): T | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('it is not a JSON object');
    return v as T;
  } catch (err) {
    onDamaged({ file, setAside: o.keep ? null : setAside(file), error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Rename a damaged file out of the way (keeping it); its new name, or null if it couldn't be moved. */
export function setAside(file: string): string | null {
  const to = `${file}.damaged-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try {
    fs.renameSync(file, to);
    return to;
  } catch {
    return null;
  }
}

/** How a damaged file was recovered, for the log. */
export function damagedMessage(d: Damaged, then: string): string {
  return `${path.basename(d.file)} was damaged (${d.error})${d.setAside ? `; it was kept as ${path.basename(d.setAside)}` : ''}. ${then}`;
}
