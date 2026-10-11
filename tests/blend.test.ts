import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/blend.js is a plain browser script, also run by the server; load it the way they do.
type Result = { usd: number; where: string; used: Record<string, number>; out: string[]; anchor: string; summary: string } | null;
type Blend = { price: (q: Record<string, number | null | undefined>, o?: object) => Result; settings: (o?: object) => { method: string; weights: Record<string, number>; tolerance: number } };
const sandbox = { window: {} as { BinderBlend: Blend }, Object, Math, Number };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/blend.js'), 'utf8'), sandbox);
const B = sandbox.window.BinderBlend;

describe('the blended daily price', () => {
  it('weighs PriceCharting 40%, TCGplayer 40% and Cardmarket 20%', () => {
    const r = B.price({ pricecharting: 100, tcgplayer: 110, cardmarket: 90 })!;
    expect(r).toMatchObject({ usd: 102, where: 'Blend', used: { pricecharting: 0.4, tcgplayer: 0.4, cardmarket: 0.2 }, out: [], anchor: 'pricecharting' });
    expect(r.summary).toBe('blend of PriceCharting US$100.00 (40%), TCGplayer US$110.00 (40%), Cardmarket US$90.00 (20%)');
  });

  it('leaves out a source more than 25% from PriceCharting, giving its share to PriceCharting', () => {
    // The Magikarp: TCGplayer and Cardmarket were Paldea Evolved's.
    const r = B.price({ pricecharting: 102.71, tcgplayer: 352.67, cardmarket: 393.61 })!;
    expect(r).toMatchObject({ usd: 102.71, where: 'PriceCharting', used: { pricecharting: 1 }, out: ['tcgplayer', 'cardmarket'] });
    expect(r.summary).toBe('PriceCharting US$102.71 · left out (more than 25% from PriceCharting): TCGplayer US$352.67, Cardmarket US$393.61');
    // One out of three: its 20% goes to PriceCharting (60/40).
    const one = B.price({ pricecharting: 100, tcgplayer: 120, cardmarket: 200 })!;
    expect(one).toMatchObject({ usd: 108, used: { pricecharting: 0.6, tcgplayer: 0.4 }, out: ['cardmarket'] });
    // Exactly 25% away still counts; below the anchor counts the same as above it.
    expect(B.price({ pricecharting: 100, tcgplayer: 125 })!.out).toEqual([]);
    expect(B.price({ pricecharting: 1.2, tcgplayer: 1.5 })!.out).toEqual([]);
    expect(B.price({ pricecharting: 100, tcgplayer: 70 })!.out).toEqual(['tcgplayer']);
  });

  it('shares a missing source’s weight among the others', () => {
    expect(B.price({ pricecharting: 100, tcgplayer: 120 })).toMatchObject({ usd: 110, used: { pricecharting: 0.5, tcgplayer: 0.5 } });
    expect(B.price({ tcgplayer: 100, cardmarket: 90 })).toMatchObject({ usd: 96.67, anchor: 'tcgplayer' });
    expect(B.price({ cardmarket: 90 })).toMatchObject({ usd: 90, where: 'Cardmarket', summary: 'Cardmarket US$90.00' });
    expect(B.price({})).toBeNull();
    expect(B.price({ pricecharting: 0, tcgplayer: null })).toBeNull();
  });

  it('takes the highest within 25% of PriceCharting, or PriceCharting’s price', () => {
    const o = { method: 'highest' };
    expect(B.price({ pricecharting: 100, tcgplayer: 120, cardmarket: 90 }, o)).toMatchObject({ usd: 120, where: 'TCGplayer', summary: 'highest of PriceCharting US$100.00, TCGplayer US$120.00, Cardmarket US$90.00' });
    const far = B.price({ pricecharting: 102.71, tcgplayer: 352.67, cardmarket: 120 }, o)!;
    expect(far).toMatchObject({ usd: 102.71, where: 'PriceCharting', out: ['tcgplayer'] });
    expect(far.summary).toBe('PriceCharting US$102.71 · the highest, TCGplayer US$352.67, is more than 25% from PriceCharting');
    // PriceCharting itself the highest: it's the anchor, so it's taken.
    expect(B.price({ pricecharting: 300, tcgplayer: 100 }, o)).toMatchObject({ usd: 300, where: 'PriceCharting' });
  });

  it('PriceCharting first, and its own weights and tolerance', () => {
    expect(B.price({ pricecharting: 100, tcgplayer: 120 }, { method: 'pricecharting' })).toMatchObject({ usd: 100, where: 'PriceCharting' });
    expect(B.price({ tcgplayer: 120, cardmarket: 90 }, { method: 'pricecharting' })).toMatchObject({ usd: 120, where: 'TCGplayer' });
    expect(B.price({ pricecharting: 100, tcgplayer: 140 }, { tolerance: 50, weights: { pricecharting: 50, tcgplayer: 50, cardmarket: 0 } })).toMatchObject({ usd: 120, out: [] });
    expect(B.settings({ method: 'nonsense', tolerance: -3, weights: { tcgplayer: 'x' } })).toEqual({ method: 'blend', weights: { pricecharting: 40, tcgplayer: 40, cardmarket: 20 }, tolerance: 25 });
  });
});

describe('rebuilding past daily prices', () => {
  // Loaded here so the vm-loaded blend above stays independent of the server modules.
  const setup = async () => {
    const os = await import('node:os');
    const { Store } = await import('../server/store');
    const { Assets } = await import('../server/assets');
    const { Config } = await import('../server/config');
    const { PriceUpdater } = await import('../server/pricing/updater');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binder-rebuild-'));
    const store = new Store(dir);
    const config = new Config(dir);
    const u = new PriceUpdater({ store, assets: new Assets(dir), config, delayMs: 0 });
    return { dir, store, config, u };
  };
  const day = (date: string, quotes: Record<string, number>, over: object = {}) => {
    const usd = Math.max(...Object.values(quotes));
    return { id: date, date, type: 'market', currency: 'CAD', auto: true, usd, amount: Math.round(usd * 140) / 100, where: 'x', quotes, note: 'Daily update · highest', ...over };
  };

  it('works each day out again with the method, at its own rate, leaving the rest alone', async () => {
    const { dir, store, config, u } = await setup();
    store.set('cards', 'a', {
      name: 'Pikachu', status: 'binder',
      prices: [
        day('2026-10-09', { pricecharting: 100, tcgplayer: 110, cardmarket: 90 }), // blend 102 (was 110)
        day('2026-10-10', { pricecharting: 102.71, tcgplayer: 352.67 }), // TCGplayer left out: 102.71 (was 352.67)
        day('2026-10-08', { pricecharting: 900 }, { grade: 'PSA 10' }), // graded: as it is
        { id: 'old', date: '2026-10-01', type: 'market', currency: 'CAD', auto: true, usd: 50, amount: 70, where: 'TCGplayer' }, // no quotes: as it is
        { id: 'mine', date: '2026-10-05', type: 'paid', currency: 'CAD', amount: 80 },
      ],
    });
    store.set('cards', 'sold', { name: 'Mew', status: 'sold', prices: [day('2026-10-10', { pricecharting: 10, tcgplayer: 20 })] });
    const preview = u.rebuildPrices(false);
    expect(preview).toMatchObject({ method: 'blend', cards: 2, prices: 3, valueBefore: 493.74, valueAfter: 143.79, copy: null });
    expect(preview.biggest[0]).toEqual({ card: 'Pikachu', before: 493.74, after: 143.79 });
    // Nothing saved by a preview.
    expect((store.get('cards', 'a')!.prices as { amount: number }[])[1].amount).toBe(493.74);
    let copied = false;
    const done = u.rebuildPrices(true, () => ((copied = true), 'db-snapshot-x.json'));
    expect(done).toMatchObject({ prices: 3, copy: 'db-snapshot-x.json' });
    expect(copied).toBe(true);
    const a = Object.fromEntries((store.get('cards', 'a')!.prices as { id: string }[]).map((e) => [e.id, e])) as unknown as Record<string, { amount: number; usd: number; where: string; note: string }>;
    expect(a['2026-10-09']).toMatchObject({ usd: 102, amount: 142.8, where: 'Blend' });
    expect(a['2026-10-09'].note).toBe('Daily update · blend of PriceCharting US$100.00 (40%), TCGplayer US$110.00 (40%), Cardmarket US$90.00 (20%) at 1.4000 (rebuilt: Blended)');
    expect(a['2026-10-10']).toMatchObject({ usd: 102.71, amount: 143.79, where: 'PriceCharting' });
    expect(a['2026-10-08']).toMatchObject({ amount: 1260 });
    expect(a.old).toMatchObject({ amount: 70 });
    expect(a.mine).toMatchObject({ amount: 80 });
    // Nothing more to do the second time; switching to Highest changes them again.
    expect(u.rebuildPrices(false).prices).toBe(0);
    config.set({ priceMethod: { method: 'highest', weights: { pricecharting: 40, tcgplayer: 40, cardmarket: 20 }, tolerance: 25 } });
    u.rebuildPrices(true);
    const h = Object.fromEntries((store.get('cards', 'a')!.prices as { id: string }[]).map((e) => [e.id, e])) as unknown as Record<string, { usd: number; where: string }>;
    expect(h['2026-10-09']).toMatchObject({ usd: 110, where: 'TCGplayer' });
    expect(h['2026-10-10']).toMatchObject({ usd: 102.71, where: 'PriceCharting' });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is set and run by administrators, with a copy of the ledger first', async () => {
    const request = (await import('supertest')).default;
    const { createApp } = await import('../server/app');
    const { Backups } = await import('../server/backups');
    const { Logger } = await import('../server/log');
    const { dir, store, config, u } = await setup();
    const log = new Logger({ stdout: false });
    const backups = new Backups(store, (u as unknown as { assets: never }).assets, config, log);
    const app = createApp({ store, assets: (u as unknown as { assets: never }).assets, log, config, updater: u, backups, publicDir: path.join(__dirname, '../public') });
    store.set('cards', 'a', { name: 'Pikachu', status: 'binder', prices: [day('2026-10-09', { pricecharting: 100, tcgplayer: 110 })] });
    await request(app).put('/api/admin/pricing/method').send({ method: 'blend', weights: { pricecharting: 0, tcgplayer: 0, cardmarket: 0 }, tolerance: 25 }).expect(400);
    await request(app).put('/api/admin/pricing/method').send({ method: 'pricecharting', weights: { pricecharting: 40, tcgplayer: 40, cardmarket: 20 }, tolerance: 25 }).expect(200);
    expect(store.get('settings', 'pricing')).toMatchObject({ priceMethod: { method: 'pricecharting' } });
    expect((await request(app).post('/api/admin/pricing/rebuild').send({}).expect(200)).body).toMatchObject({ prices: 1, copy: null });
    const r = await request(app).post('/api/admin/pricing/rebuild').send({ apply: true }).expect(200);
    expect(r.body.copy).toMatch(/^db-snapshot-.*before-rebuilding-daily-prices\.json$/);
    expect(store.get('cards', 'a')!.prices).toEqual([expect.objectContaining({ usd: 100, amount: 140, where: 'PriceCharting' })]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
