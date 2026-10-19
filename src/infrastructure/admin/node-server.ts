import fs from 'node:fs';
import path from 'node:path';
import type { DiskUsage, ServerRuntime } from '#application/admin/ports.ts';

/** Free disk space and how much the data directory holds, from the file system. */
export class NodeDiskUsage implements DiskUsage {
  readonly #dir: string;

  constructor(dataDir: string) {
    this.#dir = dataDir;
  }

  async freeBytes(): Promise<number | null> {
    try {
      const s = await fs.promises.statfs(this.#dir);
      return s.bavail * s.bsize;
    } catch {
      return null;
    }
  }

  async dataBytes(): Promise<number> {
    let total = 0;
    const walk = async (dir: string): Promise<void> => {
      for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.isFile()) total += (await fs.promises.stat(p)).size;
      }
    };
    try {
      await walk(this.#dir);
    } catch {
      // Unreadable parts are left out.
    }
    return total;
  }
}

/** This Node process: its version and how long it has been running. */
export class NodeRuntime implements ServerRuntime {
  info(): { readonly node: string; readonly uptimeSeconds: number; readonly startedAt: Date } {
    const uptimeSeconds = process.uptime();
    return { node: process.version, uptimeSeconds, startedAt: new Date(Date.now() - uptimeSeconds * 1000) };
  }
}
