import fs from 'node:fs';

/** Write a file only the server can read (0600), atomically: a crash mid-write leaves the old one. */
export function writePrivate(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
