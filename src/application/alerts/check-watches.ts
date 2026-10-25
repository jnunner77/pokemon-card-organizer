import type { CardId } from '#domain/cards/card.ts';
import { cardValue } from '#domain/cards/value.ts';
import { alertsAfterCheck, dueWatches, WATCH_SIDES, type WatchSide } from '#domain/cards/watch.ts';
import type { LedgerEvent } from '#domain/ledger/events.ts';
import { documentId } from '#domain/ledger/ids.ts';
import { ok } from '#shared/result.ts';
import { commit } from '../ledger/commit.ts';
import { type AlertLine, alertEmail } from './alert-email.ts';
import { alertAccount } from './account.ts';
import type { AlertDeps } from './deps.ts';
import { MailRefused } from './ports.ts';

/** What a check did: how many cards each alert listed (0: none sent), and why one wasn't sent. */
export interface CheckWatchesResult {
  readonly buy: number;
  readonly sell: number;
  /** Alerts were due but aren't set up (no Gmail account saved). */
  readonly notSetUp: boolean;
  readonly errors: readonly string[];
}

/** US$1 in CAD before the first price update saves the day's rate (public/app.js, the price update). */
const DEFAULT_USD_TO_CAD = 1.37;

type Due = { readonly id: string; readonly card: Readonly<Record<string, unknown>>; readonly value: number | null; readonly hits: ReturnType<typeof dueWatches> };

/**
 * Compare every watched card's value (as the binder shows it) with its watches, after a price
 * update and every hour. The cards that reached a buy price go in one email and those that
 * reached a sell price in another; what was emailed is recorded on the cards, so each is sent once
 * until its value moves back past its price. Nothing is recorded for an email that didn't go out,
 * so it's tried again at the next check. A second call while one runs joins it.
 */
export class CheckWatches {
  readonly #deps: AlertDeps;
  #running: Promise<CheckWatchesResult> | null = null;

  constructor(deps: AlertDeps) {
    this.#deps = deps;
  }

  execute(): Promise<CheckWatchesResult> {
    this.#running ??= this.#check().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #check(): Promise<CheckWatchesResult> {
    const deps = this.#deps;
    const now = deps.clock.now();
    const at = now.toISOString();
    const ledger = await deps.ledger.read();
    // The same rate the binder shows prices at: the last update's, or 1.37 before there is one (as the page and the update use).
    const saved = Number(ledger.settings.find((s) => s.id === 'main')?.['usdToCad']);
    const rate = saved > 0 ? saved : DEFAULT_USD_TO_CAD;
    const valueOf = (id: string, fields: Readonly<Record<string, unknown>>) => cardValue({ ...fields, id }, rate, (c, p) => deps.condition.adjust(c, p));

    const touched: Due[] = [];
    for (const card of ledger.cards) {
      const value = valueOf(card.id, card);
      const hits = dueWatches(card, value);
      // Due, or a record to clear (its watch moved back, changed or went).
      if (hits.length || alertsAfterCheck(card, value, new Set(), at)) touched.push({ id: card.id, card, value, hits });
    }

    const lines = (side: WatchSide): (AlertLine & { readonly id: string })[] =>
      touched.flatMap((d) => d.hits.filter((h) => h.side === side).map((h) => ({ id: d.id, card: d.card, target: h.target, price: h.price })));
    const due = { buy: lines('buy'), sell: lines('sell') };
    const account = alertAccount(deps);
    const sent = new Map<string, Set<WatchSide>>();
    const counts = { buy: 0, sell: 0 };
    const errors: string[] = [];
    const anyDue = due.buy.length > 0 || due.sell.length > 0;

    if (account && anyDue) {
      for (const side of WATCH_SIDES) {
        const list = due[side];
        if (!list.length) continue;
        try {
          await deps.mailer.send(account.mail, alertEmail(side, list, account.settings.to, account.settings.link));
          counts[side] = list.length;
          for (const l of list) (sent.get(l.id) ?? sent.set(l.id, new Set()).get(l.id))?.add(side);
          deps.log.info('pricing', `Emailed a ${side} alert for ${list.length} card${list.length === 1 ? '' : 's'} to ${account.settings.to.join(', ')}`, { cards: list.map((l) => String(l.card['name'] ?? '')) });
        } catch (error) {
          const why = error instanceof MailRefused ? `Gmail didn't accept ${account.settings.gmail} and its app password (${error.message}). Save a new app password under Administration → Alerts.` : error instanceof Error ? error.message : String(error);
          errors.push(`Couldn't email the ${side} alert: ${why}`);
          deps.log.error('pricing', `Couldn't email the ${side} alert for ${list.length} card${list.length === 1 ? '' : 's'}: ${why}. It's tried again at the next check.`);
        }
      }
    } else if (anyDue) {
      deps.log.info('pricing', `${due.buy.length + due.sell.length} price watch${due.buy.length + due.sell.length === 1 ? '' : 'es'} reached, but alert emails aren't set up (Administration → Alerts)`);
    }

    // Record what went out, and clear what moved back, on the cards as they are now.
    if (touched.length) {
      // A card that can't take the record (a field the rules refuse) is skipped and logged, so the
      // others' records are kept and their alerts aren't sent again.
      const skipped: string[] = [];
      await commit(deps, async () => {
        const events: LedgerEvent[] = [];
        for (const d of touched) {
          const id = documentId<CardId>(d.id);
          const card = id.ok ? await deps.cards.findById(id.value) : undefined;
          if (!card) continue;
          const changed = card.noteWatchCheck(valueOf(d.id, card.fields), sent.get(d.id) ?? new Set(), now);
          if (!changed.ok) {
            skipped.push(`${String(d.card['name'] ?? d.id)}: ${changed.error.message}`);
            continue;
          }
          if (!changed.value) continue;
          await deps.cards.save(card);
          events.push(...card.pullEvents());
        }
        return ok({ value: undefined, events });
      });
      for (const why of skipped) deps.log.error('pricing', `Couldn't record the price alert on ${why}. It may be emailed again.`);
    }

    if (counts.buy || counts.sell || errors.length) deps.history.note({ at, buy: counts.buy, sell: counts.sell, error: errors.length ? errors.join(' ') : null });
    return { ...counts, notSetUp: anyDue && !account, errors };
  }
}
