import type { IncomingMessage, ServerResponse } from 'node:http';
import { type Caller, requireRole } from '#application/access.ts';
import type { ReadAlertSettings } from '#application/alerts/read-alert-settings.ts';
import type { RemoveAlertSettings } from '#application/alerts/remove-alert-settings.ts';
import type { SaveAlertSettings } from '#application/alerts/save-alert-settings.ts';
import type { SendTestAlert } from '#application/alerts/send-test-alert.ts';
import { readJsonBody } from '../http/body.ts';
import type { CallerResolver } from '../http/caller.ts';
import { accessFailure, bodyFailure } from '../http/errors.ts';
import { sendFailure, sendJson } from '../http/respond.ts';
import { Router } from '../http/router.ts';
import { alertFailure } from './errors.ts';

export interface AlertRouteDeps {
  readonly identify: CallerResolver;
  readonly readAlertSettings: Pick<ReadAlertSettings, 'execute'>;
  readonly saveAlertSettings: Pick<SaveAlertSettings, 'execute'>;
  readonly removeAlertSettings: Pick<RemoveAlertSettings, 'execute'>;
  readonly sendTestAlert: Pick<SendTestAlert, 'execute'>;
}

/**
 * Administration → Alerts: the Gmail account price alerts are sent from and who they go to, as
 * routes relative to /api. Administrators only; checked before the request is read. Saving and
 * testing send an email, so they take the stricter rate limit.
 */
export function alertRoutes(deps: AlertRouteDeps): Router {
  const admin = (req: IncomingMessage, res: ServerResponse): Caller | null => {
    const r = requireRole(deps.identify(req), 'admin');
    if (r.ok) return r.value;
    req.resume();
    sendFailure(res, accessFailure(r.error));
    return null;
  };
  return new Router()
    .add('GET', '/admin/alerts', async (req, res) => {
      if (!admin(req, res)) return;
      sendJson(res, 200, await deps.readAlertSettings.execute());
    })
    .add(
      'PUT',
      '/admin/alerts',
      async (req, res) => {
        const caller = admin(req, res);
        if (!caller) return;
        const body = await readJsonBody(req);
        if (!body.ok) return sendFailure(res, bodyFailure(body.error));
        const r = await deps.saveAlertSettings.execute({ actor: caller.name, body: body.value });
        if (r.ok) sendJson(res, 200, r.value);
        else sendFailure(res, alertFailure(r.error));
      },
      { heavy: { role: 'admin' } },
    )
    .add('DELETE', '/admin/alerts', async (req, res) => {
      const caller = admin(req, res);
      if (!caller) return;
      req.resume();
      sendJson(res, 200, await deps.removeAlertSettings.execute({ actor: caller.name }));
    })
    .add(
      'POST',
      '/admin/alerts/test',
      async (req, res) => {
        const caller = admin(req, res);
        if (!caller) return;
        req.resume();
        const r = await deps.sendTestAlert.execute({ actor: caller.name });
        if (r.ok) sendJson(res, 200, r.value);
        else sendFailure(res, alertFailure(r.error));
      },
      { heavy: { role: 'admin' } },
    );
}
