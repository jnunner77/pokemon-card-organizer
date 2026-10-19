import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type Caller, requireRole, type Role } from '#application/access.ts';
import type { AdminOverview } from '#application/admin/admin-overview.ts';
import type { ChangePriceMethod } from '#application/admin/change-price-method.ts';
import type { ChangePriceSchedule } from '#application/admin/change-price-schedule.ts';
import type { ListProblems } from '#application/admin/list-problems.ts';
import type { MarkProblemsSeen } from '#application/admin/mark-problems-seen.ts';
import type { OpenLogFile } from '#application/admin/open-log-file.ts';
import type { ReadPriceSettings } from '#application/admin/read-price-settings.ts';
import type { RemovePriceChartingToken } from '#application/admin/remove-pricecharting-token.ts';
import type { ReportPageError } from '#application/admin/report-page-error.ts';
import type { SavePriceChartingToken } from '#application/admin/save-pricecharting-token.ts';
import type { SearchLogs } from '#application/admin/search-logs.ts';
import type { SignedInGuest } from '#application/guests/state.ts';
import { readJsonBody } from '../http/body.ts';
import type { CallerResolver, IdentityResolver } from '../http/caller.ts';
import type { ClientResolver } from '../http/client.ts';
import { accessFailure, badRequest, bodyFailure } from '../http/errors.ts';
import { attachment, type Failure, sendFailure, sendJson, sendNoContent } from '../http/respond.ts';
import { Router } from '../http/router.ts';
import { adminFailure } from './errors.ts';
import { parseLogQuery } from './parse.ts';

/** Largest page error report. */
const PAGE_ERROR_LIMIT_BYTES = 16 * 1024;
const LOCAL = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/;

export interface AdminRouteDeps {
  readonly identify: CallerResolver;
  readonly identity: IdentityResolver;
  readonly client: ClientResolver;
  /** The signed-in guest; null on a server without guest viewing (no guest error reports then). */
  readonly guest: ((req: IncomingMessage) => SignedInGuest | null) | null;
  /** Whether the server trusts the reverse proxy's X-Forwarded-For (TRUST_PROXY). */
  readonly trustsProxy: boolean;
  readonly overview: Pick<AdminOverview, 'execute'>;
  readonly readPriceSettings: Pick<ReadPriceSettings, 'execute'>;
  readonly changePriceSchedule: Pick<ChangePriceSchedule, 'execute'>;
  readonly changePriceMethod: Pick<ChangePriceMethod, 'execute'>;
  readonly savePriceChartingToken: Pick<SavePriceChartingToken, 'execute'>;
  readonly removePriceChartingToken: Pick<RemovePriceChartingToken, 'execute'>;
  readonly listProblems: Pick<ListProblems, 'execute'>;
  readonly markProblemsSeen: Pick<MarkProblemsSeen, 'execute'>;
  readonly searchLogs: Pick<SearchLogs, 'execute'>;
  readonly openLogFile: Pick<OpenLogFile, 'execute'>;
  readonly reportPageError: Pick<ReportPageError, 'execute'>;
}

/** The query string: everything after the first "?". */
const queryOf = (req: IncomingMessage): URLSearchParams => {
  const url = req.url ?? '';
  const at = url.indexOf('?');
  return new URLSearchParams(at < 0 ? '' : url.slice(at + 1));
};
const isPrematureClose = (error: unknown): boolean => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ERR_STREAM_PREMATURE_CLOSE';
const NO_SUCH_LOG: Failure = { status: 404, code: 'not_found', message: 'No such log file' };

/**
 * Administration's overview, price settings and PriceCharting token, problems and logs, and the
 * pages' error reports, as routes relative to /api. Administrator-only routes check before reading
 * the request.
 */
export function adminRoutes(deps: AdminRouteDeps): Router {
  const allowed = (req: IncomingMessage, res: ServerResponse, needs: Role): Caller | null => {
    const r = requireRole(deps.identify(req), needs);
    if (r.ok) return r.value;
    req.resume();
    sendFailure(res, accessFailure(r.error));
    return null;
  };
  const body = async (req: IncomingMessage, res: ServerResponse, limit?: number): Promise<{ value: unknown } | null> => {
    const r = await readJsonBody(req, limit);
    if (r.ok) return { value: r.value };
    sendFailure(res, bodyFailure(r.error));
    return null;
  };
  const pageError = async (req: IncomingMessage, res: ServerResponse, by: Readonly<Record<string, unknown>>) => {
    const sent = await body(req, res, PAGE_ERROR_LIMIT_BYTES);
    if (!sent) return;
    const r = deps.reportPageError.execute({ report: sent.value, by });
    if (r.ok) sendNoContent(res);
    else sendFailure(res, adminFailure(r.error));
  };

  const router = new Router()
    // ---- errors in the pages themselves ----
    .add('POST', '/client-error', async (req, res) => {
      const caller = allowed(req, res, 'viewer');
      if (caller) await pageError(req, res, { user: caller.name });
    })

    // ---- the overview ----
    .add('GET', '/admin/overview', async (req, res) => {
      const caller = allowed(req, res, 'admin');
      if (!caller) return;
      const client = deps.client(req);
      const identity = deps.identity(req);
      const report = await deps.overview.execute({ secure: client.secure, untrustedProxy: !!req.headers['x-forwarded-for'] && !deps.trustsProxy, localRequest: LOCAL.test(client.ip) });
      sendJson(res, 200, { checks: report.checks, you: { username: caller.name, name: identity?.displayName }, ledger: report.ledger, server: report.server });
    })

    // ---- price updates and PriceCharting's token ----
    .add('GET', '/admin/pricing', async (req, res) => {
      if (!allowed(req, res, 'admin')) return;
      sendJson(res, 200, deps.readPriceSettings.execute());
    })
    .add('PUT', '/admin/pricing', async (req, res) => {
      const caller = allowed(req, res, 'admin');
      if (!caller) return;
      const sent = await body(req, res);
      if (!sent) return;
      const r = deps.changePriceSchedule.execute({ actor: caller.name, schedule: sent.value });
      if (r.ok) sendJson(res, 200, r.value);
      else sendFailure(res, adminFailure(r.error));
    })
    .add('PUT', '/admin/pricing/method', async (req, res) => {
      const caller = allowed(req, res, 'admin');
      if (!caller) return;
      const sent = await body(req, res);
      if (!sent) return;
      const r = deps.changePriceMethod.execute({ actor: caller.name, method: sent.value });
      if (r.ok) sendJson(res, 200, r.value);
      else sendFailure(res, adminFailure(r.error));
    })
    .add(
      'PUT',
      '/admin/pricing/pricecharting-token',
      async (req, res) => {
        const caller = allowed(req, res, 'admin');
        if (!caller) return;
        const sent = await body(req, res);
        if (!sent) return;
        const r = await deps.savePriceChartingToken.execute({ actor: caller.name, body: sent.value });
        if (r.ok) sendJson(res, 200, r.value);
        else sendFailure(res, adminFailure(r.error));
      },
      { heavy: { role: 'admin' } },
    )
    .add('DELETE', '/admin/pricing/pricecharting-token', async (req, res) => {
      const caller = allowed(req, res, 'admin');
      if (!caller) return;
      req.resume();
      const r = deps.removePriceChartingToken.execute({ actor: caller.name });
      if (r.ok) sendJson(res, 200, r.value);
      else sendFailure(res, adminFailure(r.error));
    })

    // ---- problems: every warning and error since an administrator last marked them as seen ----
    .add('GET', '/admin/problems', async (req, res) => {
      if (!allowed(req, res, 'admin')) return;
      const all = queryOf(req).getAll('all');
      sendJson(res, 200, deps.listProblems.execute({ all: all.length === 1 && all[0] === '1' }));
    })
    .add('POST', '/admin/problems/seen', async (req, res) => {
      if (!allowed(req, res, 'admin')) return;
      const sent = await body(req, res);
      if (!sent) return;
      const r = deps.markProblemsSeen.execute({ body: sent.value });
      if (r.ok) sendJson(res, 200, r.value);
      else sendFailure(res, adminFailure(r.error));
    })

    // ---- logs ----
    .add('GET', '/admin/logs', async (req, res) => {
      if (!allowed(req, res, 'admin')) return;
      const query = parseLogQuery(queryOf(req));
      if (!query.ok) return sendFailure(res, badRequest(query.error));
      sendJson(res, 200, deps.searchLogs.execute(query.value));
    })
    .add('GET', '/admin/logs/files/:name', async (req, res, p) => {
      if (!allowed(req, res, 'admin')) return;
      const name = p['name'] ?? '';
      const file = await deps.openLogFile.execute({ name });
      if (!file) return sendFailure(res, NO_SUCH_LOG);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Length', file.bytes);
      res.setHeader('Content-Disposition', attachment(`binder-log-${name}`));
      // Its own stream when it is one, so a HEAD request closes it; the log's file content opens only when read.
      const content = file.content instanceof Readable ? file.content : Readable.from(file.content);
      if (req.method === 'HEAD') {
        content.destroy();
        res.end();
        return;
      }
      try {
        await pipeline(content, res);
      } catch (error) {
        // The browser cancelled the download: nothing went wrong here. A file that can't be read is still an error.
        if (!isPrematureClose(error)) throw error;
      }
    });

  // The guest page's errors, from a signed-in guest.
  const guest = deps.guest;
  if (guest)
    router.add('POST', '/guest/client-error', async (req, res) => {
      if (!guest(req)) {
        req.resume();
        return sendFailure(res, accessFailure({ code: 'SIGN_IN_REQUIRED' }));
      }
      await pageError(req, res, { guest: true });
    });
  return router;
}
