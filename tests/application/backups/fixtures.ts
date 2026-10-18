import type { BackupDeps } from '#application/backups/deps.ts';
import { PruneCopies } from '#application/backups/prune-copies.ts';
import { MemoryBackupSettings, MemoryKeptCopies, MemoryWholeLedger } from '#infrastructure/memory/backups.ts';
import { MemoryPhotoStore } from '#infrastructure/memory/photos.ts';
import { NodeBase64 } from '#infrastructure/node-base64.ts';

export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);
export const photoId = (n: number) => n.toString(16).padStart(32, '0');

/** The backup use cases' dependencies in memory, on a clock the test moves, with what was logged. */
export function setUp() {
  let now = new Date('2026-10-18T12:00:00.000Z');
  const clock = { now: () => now };
  const copies = new MemoryKeptCopies();
  copies.now = clock.now;
  const photos = new MemoryPhotoStore();
  photos.now = clock.now;
  const ledger = new MemoryWholeLedger(copies);
  const settings = new MemoryBackupSettings();
  const logged: string[] = [];
  const log = { info: (m: string) => void logged.push(m), warn: (m: string) => void logged.push(`warn: ${m}`) };
  const deps: BackupDeps = { photos, ledgerPhotos: ledger, copies, ledger, settings, clock, base64: new NodeBase64(), log, adminLog: log };
  return { deps, photos, copies, ledger, settings, logged, prune: new PruneCopies(deps), setNow: (d: Date) => void (now = d) };
}
