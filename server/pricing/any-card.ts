// Today's prices for any card, in the ledger or not (Find a card → Any card), worked out the way
// the daily update would price it (updater.ts): TCGplayer's own catalog for a printing the card
// database has no TCGplayer price for, PriceCharting's product for each printing, and the price
// method's blend. Nothing is saved. The card itself comes from the card database
// (src/application/catalog/show-any-card.ts); this stays with the price update until its slice
// moves into the layers.

import type { AnyCardPrices, AnyCardPricing, AnyCardToPrice, LookupPrinting } from '#application/catalog/ports.ts';
import { numberWithTotal } from '#domain/catalog/any-card.ts';
import { mapRarity } from '#domain/catalog/rarity.ts';
import { tcgplayerUrl } from '#domain/catalog/tcgplayer.ts';
import { blend } from '../blend.ts';
import { catalogMismatch, chooseMatch, searchQuery } from './match.ts';
import type { PcProduct } from './pricecharting.ts';
import type { PriceUpdater } from './updater.ts';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Prices any card with the daily update's sources and method; without one, from the card database alone. */
export class TodaysPrices implements AnyCardPricing {
  private readonly updater?: PriceUpdater;

  constructor(updater?: PriceUpdater) {
    this.updater = updater;
  }

  async price(o: AnyCardToPrice): Promise<AnyCardPrices> {
    const { card: td, setCode, total, parentSet } = o;
    const notes: string[] = [];
    const rates = this.updater?.savedRates() ?? { usd: 1.37, eur: null };
    const schedule = this.updater?.schedule();
    const useCardmarket = (schedule?.cardmarket ?? true) && !!rates.eur;
    const method = this.updater?.priceMethod() ?? blend().settings(null);
    const base = o.printings.map((p) => ({ ...p }));

    // As the daily update does: TCGplayer's own catalog for a printing the card databases have no TCGplayer price for.
    if (this.updater) {
      const updater = this.updater;
      const failed: { label: string; reason: string }[] = [];
      await Promise.all(
        base.map(async (p) => {
          if (p.tcgplayer) return;
          try {
            const q = await updater.lookupTcgplayer({ name: td.name, set: td.set.name, setCode, number: numberWithTotal(td.localId, total), variant: p.variant, rarity: mapRarity(td.rarity), tcgdexSet: td.set.name }, p.product);
            if (q?.usd != null) p.tcgplayer = { usd: q.usd, productId: q.productId };
          } catch (err) {
            failed.push({ label: p.label, reason: err instanceof Error ? err.message : String(err) });
          }
        }),
      );
      if (failed.length) {
        const which = base.filter((p) => failed.some((f) => f.label === p.label)).map((p) => p.label);
        notes.push(`No TCGplayer price from TCGplayer's catalog (tcgcsv.com) for the ${which.join(', ')} printing${which.length === 1 ? '' : 's'}: it didn't answer (${failed[0].reason}).`);
      }
    }

    let products: PcProduct[] = [];
    let asked = !!this.updater;
    if (this.updater) {
      try {
        products = await this.updater.lookupProducts(searchQuery({ name: td.name, number: td.localId }));
      } catch (err) {
        asked = false;
        notes.push(`No PriceCharting prices: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const printings = base.map((p): { printing: LookupPrinting; product: string | null } => {
      const card = { name: td.name, number: td.localId, set: td.set.name, variant: p.variant };
      let pc = asked ? (chooseMatch(card, products).match as PcProduct | null) : null;
      // A reprint sub-set's card (30th Classic Collection) is PriceCharting's under the set it belongs to (30th Celebration).
      if (asked && !pc && parentSet) pc = chooseMatch({ ...card, set: parentSet }, products).match as PcProduct | null;
      const quotes: Record<string, number> = {};
      if (pc?.usd != null) quotes.pricecharting = pc.usd;
      if (p.tcgplayer) quotes.tcgplayer = p.tcgplayer.usd;
      if (useCardmarket && p.cardmarketEur != null && rates.eur) quotes.cardmarket = round2((p.cardmarketEur * rates.eur) / rates.usd);
      // As the daily update does: TCGdex's prices count only when its card is PriceCharting's product's set and printing.
      const leftOut = quotes.pricecharting != null && (quotes.tcgplayer != null || quotes.cardmarket != null) ? catalogMismatch(card, pc, td.set.name, parentSet) : null;
      if (leftOut) {
        delete quotes.tcgplayer;
        delete quotes.cardmarket;
      }
      const picked = blend().price(quotes, method);
      const grades = Object.entries(pc?.grades ?? {}).map(([label, usd]) => ({ label, usd, cad: round2(usd * rates.usd) }));
      return {
        printing: {
          label: p.label,
          variant: p.variant,
          tcgplayer: p.tcgplayer ? { usd: p.tcgplayer.usd, url: p.tcgplayer.productId ? tcgplayerUrl(p.tcgplayer.productId) : null } : null,
          cardmarket: p.cardmarketEur != null ? { eur: p.cardmarketEur } : null,
          pricecharting: pc ? { id: pc.id, url: pc.url, title: pc.title, usd: pc.usd, grades } : null,
          leftOut,
          price: picked ? { usd: picked.usd, cad: round2(picked.usd * rates.usd), where: picked.where, summary: picked.summary } : null,
        },
        product: p.tcgplayer?.productId ?? null,
      };
    });
    if (asked && !printings.some((p) => p.printing.pricecharting)) notes.push('PriceCharting has no certain match for this card.');
    if (!useCardmarket && base.some((p) => p.cardmarketEur != null)) {
      notes.push(schedule?.cardmarket === false ? "Cardmarket's prices aren't counted: it's left out under Administration → Prices." : "Cardmarket's prices aren't counted until a price update has the euro's exchange rate.");
    }
    return { printings, rates, notes };
  }
}
