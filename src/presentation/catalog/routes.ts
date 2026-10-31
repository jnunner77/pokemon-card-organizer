import type { IncomingMessage, ServerResponse } from 'node:http';
import { type Caller, requireRole, type Role } from '#application/access.ts';
import type { ChooseMatch } from '#application/catalog/choose-match.ts';
import type { CreateMasterSet } from '#application/catalog/create-master-set.ts';
import type { FillEveryCard } from '#application/catalog/fill-every-card.ts';
import type { ListMasterSetSets } from '#application/catalog/list-master-set-sets.ts';
import type { LookUpCard } from '#application/catalog/look-up-card.ts';
import type { PreviewMasterSet } from '#application/catalog/preview-master-set.ts';
import type { SearchAnyCard } from '#application/catalog/search-any-card.ts';
import type { ShowAnyCard } from '#application/catalog/show-any-card.ts';
import type { ShowAnyCardDetails } from '#application/catalog/show-any-card-details.ts';
import { isCardDatabaseId } from '#domain/catalog/tcgdex.ts';
import { isDocumentId } from '#domain/ledger/ids.ts';
import { readJsonBody } from '../http/body.ts';
import type { CallerResolver } from '../http/caller.ts';
import { accessFailure, badRequest, bodyFailure } from '../http/errors.ts';
import { isRecord } from '../http/parse.ts';
import { sendFailure, sendJson } from '../http/respond.ts';
import { Router } from '../http/router.ts';
import { ANY_CARD_OFF, anyCardFailure, chooseFailure, LOOKUPS_OFF, lookupFailure, masterSetFailure, NO_SUCH_CARD, NOT_IN_DATABASE } from './errors.ts';
import { lookupQuery, masterSetBody, searchQuery, setQuery } from './parse.ts';

/** Asking the card databases about cards; absent when card lookups are turned off (CARD_LOOKUPS=off). */
export interface CatalogUseCases {
  readonly lookUpCard: Pick<LookUpCard, 'execute'>;
  readonly chooseMatch: Pick<ChooseMatch, 'execute'>;
  readonly fillEveryCard: Pick<FillEveryCard, 'execute'>;
  readonly searchAnyCard: Pick<SearchAnyCard, 'execute'>;
  readonly showAnyCard: Pick<ShowAnyCard, 'execute'>;
  readonly showAnyCardDetails: Pick<ShowAnyCardDetails, 'execute'>;
  readonly listMasterSetSets: Pick<ListMasterSetSets, 'execute'>;
  readonly previewMasterSet: Pick<PreviewMasterSet, 'execute'>;
  readonly createMasterSet: Pick<CreateMasterSet, 'execute'>;
}

export interface CatalogRouteDeps {
  readonly identify: CallerResolver;
  /** Null when card lookups are turned off: the routes answer 503. */
  readonly catalog: CatalogUseCases | null;
}

/** The query string: everything after the first "?". */
const queryOf = (req: IncomingMessage): URLSearchParams => {
  const url = req.url ?? '';
  const at = url.indexOf('?');
  return new URLSearchParams(at < 0 ? '' : url.slice(at + 1));
};

/**
 * Card details from the card database (the Add card form's lookup, "this is my card", Fill in
 * missing details), Find a card → Any card, and master sets, as routes relative to /api. Each
 * checks who is calling before reading the request.
 */
export function catalogRoutes(deps: CatalogRouteDeps): Router {
  const { catalog } = deps;
  /** The caller if they may do this, or the refusal sent. */
  const allowed = (req: IncomingMessage, res: ServerResponse, needs: Role): Caller | null => {
    const r = requireRole(deps.identify(req), needs);
    if (r.ok) return r.value;
    req.resume();
    sendFailure(res, accessFailure(r.error));
    return null;
  };
  /** The JSON body, or the refusal sent. */
  const body = async (req: IncomingMessage, res: ServerResponse): Promise<{ value: unknown } | null> => {
    const r = await readJsonBody(req);
    if (r.ok) return { value: r.value };
    sendFailure(res, bodyFailure(r.error));
    return null;
  };
  const editor = { heavy: { role: 'editor' } } as const;

  return (
    new Router()
      // ---- card details (TCGdex) ----
      // The Add card form: the cards with this name and number.
      .add('GET', '/cards/lookup', async (req, res) => {
        if (!allowed(req, res, 'editor')) return;
        if (!catalog) return sendFailure(res, LOOKUPS_OFF);
        const q = lookupQuery(queryOf(req));
        if (!q) return sendFailure(res, badRequest('Give the card name and number.'));
        const r = await catalog.lookUpCard.execute(q);
        if (r.ok) sendJson(res, 200, r.value);
        else sendFailure(res, lookupFailure(r.error));
      })
      // "This is my card": one of several matches, or a name suggested for a card not found.
      .add('POST', '/cards/:id/details', async (req, res, p) => {
        if (!allowed(req, res, 'editor')) return;
        const sent = await body(req, res);
        if (!sent) return;
        if (!catalog) return sendFailure(res, LOOKUPS_OFF);
        const cardId = p['id'] ?? '';
        if (!isDocumentId(cardId)) return sendFailure(res, NO_SUCH_CARD);
        const r = await catalog.chooseMatch.execute({ cardId, matchId: isRecord(sent.value) ? sent.value['id'] : undefined });
        if (r.ok) sendJson(res, 200, r.value);
        else sendFailure(res, chooseFailure(r.error));
      })
      // Fill in missing details: every card with blanks, one at a time (force: those looked up this week too).
      .add(
        'POST',
        '/cards/fill-details',
        async (req, res) => {
          const caller = allowed(req, res, 'editor');
          if (!caller) return;
          req.resume();
          if (!catalog) return sendFailure(res, LOOKUPS_OFF);
          const force = queryOf(req).getAll('force');
          sendJson(res, 202, await catalog.fillEveryCard.execute({ actor: caller.name, force: force.length === 1 && force[0] === '1' }));
        },
        editor,
      )

      // ---- any card, in the ledger or not: nothing is saved ----
      .add('GET', '/lookup/search', async (req, res) => {
        if (!allowed(req, res, 'viewer')) return;
        const q = searchQuery(queryOf(req));
        if (q === null) return sendFailure(res, badRequest('Type a card name, set or number.'));
        if (!catalog) return sendFailure(res, ANY_CARD_OFF);
        const r = await catalog.searchAnyCard.execute({ query: q });
        if (r.ok) sendJson(res, 200, r.value);
        else sendFailure(res, lookupFailure(r.error));
      })
      .add('GET', '/lookup/cards/:id', async (req, res, p) => {
        if (!allowed(req, res, 'viewer')) return;
        const id = p['id'] ?? '';
        if (!isCardDatabaseId(id)) return sendFailure(res, NOT_IN_DATABASE);
        if (!catalog) return sendFailure(res, ANY_CARD_OFF);
        const r = await catalog.showAnyCard.execute({ id });
        if (r.ok) sendJson(res, 200, r.value);
        else sendFailure(res, anyCardFailure(r.error));
      })
      .add('GET', '/lookup/cards/:id/details', async (req, res, p) => {
        if (!allowed(req, res, 'viewer')) return;
        const id = p['id'] ?? '';
        if (!isCardDatabaseId(id)) return sendFailure(res, NOT_IN_DATABASE);
        if (!catalog) return sendFailure(res, ANY_CARD_OFF);
        const r = await catalog.showAnyCardDetails.execute({ id });
        if (r.ok) sendJson(res, 200, r.value);
        else sendFailure(res, anyCardFailure(r.error));
      })

      // ---- master sets: previewed first, then made as a new binder of placeholders ----
      .add('GET', '/master-sets/sets', async (req, res) => {
        if (!allowed(req, res, 'editor')) return;
        if (!catalog) return sendFailure(res, LOOKUPS_OFF);
        const r = await catalog.listMasterSetSets.execute();
        if (r.ok) sendJson(res, 200, r.value);
        else sendFailure(res, masterSetFailure(r.error));
      })
      .add(
        'GET',
        '/master-sets/preview',
        async (req, res) => {
          if (!allowed(req, res, 'editor')) return;
          const set = setQuery(queryOf(req));
          if (set === null) return sendFailure(res, badRequest('Type the set.'));
          if (!catalog) return sendFailure(res, LOOKUPS_OFF);
          const r = await catalog.previewMasterSet.execute({ set });
          if (r.ok) sendJson(res, 200, r.value);
          else sendFailure(res, masterSetFailure(r.error));
        },
        editor,
      )
      .add(
        'POST',
        '/master-sets',
        async (req, res) => {
          const caller = allowed(req, res, 'editor');
          if (!caller) return;
          const sent = await body(req, res);
          if (!sent) return;
          const input = masterSetBody(sent.value);
          if (!input) return sendFailure(res, badRequest('Give the set, its owner, a binder name and the pockets per page.'));
          if (!catalog) return sendFailure(res, LOOKUPS_OFF);
          const r = await catalog.createMasterSet.execute({ actor: caller.name, ...input });
          if (r.ok) sendJson(res, 201, r.value);
          else sendFailure(res, masterSetFailure(r.error));
        },
        editor,
      )
  );
}
