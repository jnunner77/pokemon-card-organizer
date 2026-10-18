import type { IncomingMessage, ServerResponse } from 'node:http';
import { type Caller, requireRole, type Role } from '#application/access.ts';
import type { ChangeRetention } from '#application/backups/change-retention.ts';
import type { DeleteCopy } from '#application/backups/delete-copy.ts';
import type { DownloadCopy } from '#application/backups/download-copy.ts';
import type { DownloadFullBackup } from '#application/backups/download-full-backup.ts';
import type { ListCopies } from '#application/backups/list-copies.ts';
import type { RestoreCopy } from '#application/backups/restore-copy.ts';
import type { RestoreFullBackup } from '#application/backups/restore-full-backup.ts';
import type { TakeSnapshot } from '#application/backups/take-snapshot.ts';
import { isRecord } from '../http/parse.ts';
import { readJsonBody } from '../http/body.ts';
import type { CallerResolver } from '../http/caller.ts';
import { accessFailure, bodyFailure } from '../http/errors.ts';
import { attachment, sendFailure, sendJson, sendNoContent, sendText } from '../http/respond.ts';
import { Router } from '../http/router.ts';
import { backupFailure } from './errors.ts';

/** Largest restore upload. The reverse proxy may cap it lower; `npm run import-backup` has no cap. */
export const RESTORE_LIMIT_BYTES = 200 * 1024 * 1024;
const MAX_LABEL = 40;

export interface BackupRouteDeps {
  readonly identify: CallerResolver;
  readonly downloadFullBackup: Pick<DownloadFullBackup, 'execute'>;
  readonly restoreFullBackup: Pick<RestoreFullBackup, 'execute'>;
  readonly listCopies: Pick<ListCopies, 'execute'>;
  readonly changeRetention: Pick<ChangeRetention, 'execute'>;
  readonly takeSnapshot: Pick<TakeSnapshot, 'execute'>;
  readonly downloadCopy: Pick<DownloadCopy, 'execute'>;
  readonly restoreCopy: Pick<RestoreCopy, 'execute'>;
  readonly deleteCopy: Pick<DeleteCopy, 'execute'>;
}

/** Full backups (with photos) and the ledger's kept copies, as routes relative to /api. */
export function backupRoutes(deps: BackupRouteDeps): Router {
  const allowed = (req: IncomingMessage, res: ServerResponse, needs: Role): Caller | null => {
    const r = requireRole(deps.identify(req), needs);
    if (r.ok) return r.value;
    sendFailure(res, accessFailure(r.error));
    return null;
  };
  const body = async (req: IncomingMessage, res: ServerResponse, limit?: number): Promise<{ value: unknown } | null> => {
    const r = await readJsonBody(req, limit);
    if (r.ok) return { value: r.value };
    sendFailure(res, bodyFailure(r.error));
    return null;
  };
  const heavy = { heavy: true };

  return (
    new Router()
      // ---- full backups ----
      .add(
        'GET',
        '/backup',
        async (req, res) => {
          const caller = allowed(req, res, 'editor');
          if (!caller) return;
          const { filename, backup } = await deps.downloadFullBackup.execute({ actor: caller.name });
          res.setHeader('Content-Disposition', attachment(filename));
          sendJson(res, 200, backup);
        },
        heavy,
      )
      .add(
        'POST',
        '/restore',
        async (req, res) => {
          const caller = allowed(req, res, 'admin');
          if (!caller) return;
          const backup = await body(req, res, RESTORE_LIMIT_BYTES);
          if (!backup) return;
          const r = await deps.restoreFullBackup.execute({ actor: caller.name, backup: backup.value });
          if (r.ok) sendJson(res, 200, r.value);
          else sendFailure(res, backupFailure(r.error));
        },
        heavy,
      )

      // ---- the ledger's kept copies (Administration → Backups) ----
      .add('GET', '/admin/backups', async (req, res) => {
        if (!allowed(req, res, 'admin')) return;
        sendJson(res, 200, await deps.listCopies.execute());
      })
      .add('PUT', '/admin/backups/retention', async (req, res) => {
        const caller = allowed(req, res, 'admin');
        if (!caller) return;
        const retention = await body(req, res);
        if (!retention) return;
        const r = await deps.changeRetention.execute({ actor: caller.name, retention: retention.value });
        if (r.ok) sendJson(res, 200, r.value);
        else sendFailure(res, backupFailure(r.error));
      })
      .add(
        'POST',
        '/admin/backups/snapshot',
        async (req, res) => {
          const caller = allowed(req, res, 'admin');
          if (!caller) return;
          const sent = await body(req, res);
          if (!sent) return;
          const label = isRecord(sent.value) && typeof sent.value['label'] === 'string' ? sent.value['label'].slice(0, MAX_LABEL) : undefined;
          sendJson(res, 201, await deps.takeSnapshot.execute({ actor: caller.name, label }));
        },
        heavy,
      )
      .add(
        'GET',
        '/admin/backups/:name',
        async (req, res, p) => {
          if (!allowed(req, res, 'admin')) return;
          const r = await deps.downloadCopy.execute({ name: p['name'] ?? '' });
          if (r.ok) sendText(res, 'application/json; charset=utf-8', r.value.text, r.value.name);
          else sendFailure(res, backupFailure(r.error));
        },
        heavy,
      )
      .add(
        'POST',
        '/admin/backups/:name/restore',
        async (req, res, p) => {
          const caller = allowed(req, res, 'admin');
          if (!caller) return;
          req.resume();
          const r = await deps.restoreCopy.execute({ actor: caller.name, name: p['name'] ?? '' });
          if (r.ok) sendJson(res, 200, r.value);
          else sendFailure(res, backupFailure(r.error));
        },
        heavy,
      )
      .add('DELETE', '/admin/backups/:name', async (req, res, p) => {
        const caller = allowed(req, res, 'admin');
        if (!caller) return;
        req.resume();
        const r = await deps.deleteCopy.execute({ actor: caller.name, name: p['name'] ?? '' });
        if (r.ok) sendNoContent(res);
        else sendFailure(res, backupFailure(r.error));
      })
  );
}
