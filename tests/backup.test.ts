import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// deploy/backup.sh runs `docker compose exec … tar`; a stand-in `docker` on PATH prints a tiny archive.
let dir: string;
let bin: string;
let dest: string;
const mode = (p: string) => fs.statSync(p).mode & 0o777;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-backup-'));
  bin = path.join(dir, 'bin');
  dest = path.join(dir, 'backups');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nprintf data | gzip\n', { mode: 0o755 });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function backup() {
  // A permissive umask, like a typical login shell or cron job.
  return spawnSync('bash', ['-c', 'umask 022; exec deploy/backup.sh "$1"', 'backup', dest], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    encoding: 'utf8',
  });
}

describe('deploy/backup.sh', () => {
  it('writes archives only their owner can read, and fixes older ones', () => {
    fs.mkdirSync(dest, { mode: 0o755 });
    const old = path.join(dest, 'binder-20250101-000000.tar.gz');
    fs.writeFileSync(old, 'old');
    fs.chmodSync(old, 0o644);

    const run = backup();
    expect(run.status, run.stderr).toBe(0);
    const archives = fs.readdirSync(dest).filter((f) => f.endsWith('.tar.gz'));
    expect(archives).toHaveLength(2);
    expect(mode(dest)).toBe(0o700);
    for (const a of archives) expect(mode(path.join(dest, a)), a).toBe(0o600);
  });
});
