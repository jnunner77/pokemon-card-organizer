import type { Check } from './checks.ts';

// A plain-text status file for the server's nightly job (Boards' deploy/ops/nightly.sh), which
// reads it with `docker compose exec binder cat /data/status.txt` and alerts on it. One line each:
//   written <ISO time>
//   ok|warn|fail <check title>: <detail> [Fix: <what to do>]
//   attention <card>: <what a person needs to do>

/** Checks that depend on the request a person makes in the browser; meaningless in the file. */
const PER_REQUEST = new Set(['https', 'proxy']);

export function statusText(now: Date, checks: readonly Check[], attention: readonly string[]): string {
  const one = (s: string) => s.replace(/\s+/g, ' ').trim();
  const lines = [`written ${now.toISOString()}`];
  for (const c of checks) {
    if (PER_REQUEST.has(c.id)) continue;
    const level = c.status === 'fail' ? 'fail' : c.status === 'warn' ? 'warn' : 'ok';
    lines.push(one(`${level} ${c.title}: ${c.detail}${level !== 'ok' && c.fix ? ` Fix: ${c.fix}` : ''}`));
  }
  for (const a of attention) lines.push(one(`attention ${a}`));
  return `${lines.join('\n')}\n`;
}
