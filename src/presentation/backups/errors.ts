import type { CopyNotFound } from '#application/backups/download-copy.ts';
import type { InvalidBackup } from '#domain/backups/full-backup.ts';
import type { InvalidRetention } from '#domain/backups/retention.ts';
import type { InvalidDocument } from '#domain/ledger/check-document.ts';
import { assertNever } from '#shared/result.ts';
import { badRequest } from '../http/errors.ts';
import type { Failure } from '../http/respond.ts';

export function backupFailure(e: InvalidBackup | InvalidRetention | InvalidDocument | CopyNotFound): Failure {
  switch (e.code) {
    case 'INVALID_BACKUP':
    case 'INVALID_RETENTION':
    case 'INVALID_DOCUMENT':
      return badRequest(e.message);
    case 'COPY_NOT_FOUND':
      return { status: 404, code: 'not_found', message: 'No such backup' };
    default:
      return assertNever(e);
  }
}
