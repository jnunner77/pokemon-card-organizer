import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/trades.js is a plain browser script; load it the way the page does (after trade.js).
type Side = { pct: string; cash: string; items: Record<string, unknown>[] };
type T = { id: string | null; n: number; customer: string; dealer: Side; mine: Side; version: number };
type View = { id: string; number: number; customer: string; dealer: Side; mine: Side; version: number };
type Err = Error & { code?: string };
type Saver = {
  changed: (t: T) => void;
  discard: (id: string) => Promise<boolean | null>;
  settle: (id: string) => Promise<void>;
  forget: (id: string) => void;
  retryAll: () => void;
  status: (id: string) => 'saved' | 'saving' | 'unsaved' | 'invalid' | 'denied';
};
type SaverOptions = {
  put: (id: string, wire: unknown) => Promise<View>;
  del: (id: string) => Promise<void>;
  wait: (ms: number) => Promise<void>;
  delayMs?: number;
  retryMs?: number[];
  onSaved?: (id: string, view: View) => void;
  onConflict?: (id: string) => void;
  onClosed?: (id: string) => void;
  onFull?: (id: string) => void;
  onInvalid?: (id: string) => void;
  onDenied?: (id: string) => void;
  onStatus?: (id: string) => void;
};
type Trades = {
  MAX: number;
  MAX_CUSTOMER: number;
  MAX_FIELD: number;
  MAX_SIDE_CARDS: number;
  blank: (n: number) => T;
  isEmpty: (t: unknown) => boolean;
  label: (t: unknown) => string;
  summary: (t: unknown) => string;
  nextNumber: (trades: { n: number }[]) => number;
  toWire: (t: T) => { baseVersion: number; customer: string; dealer: Side; mine: Side };
  afterClose: (trades: { id: string }[], id: string) => string | null;
  reconcile: (local: T[], server: View[], pending: Set<string> | string[], since?: Map<string, number>) => { trades: T[]; conflicts: { id: string; mine: T }[]; closed: T[] };
  fromLegacy: (saved: unknown, n: number, owned: Set<string> | null, graders: string[]) => T | null;
  createSaver: (o: SaverOptions) => Saver;
};
const sandbox = { window: {} as { BinderTrades: Trades } };
for (const f of ['bulkbuy.js', 'trade.js', 'trades.js']) vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public', f), 'utf8'), sandbox);
const B = sandbox.window.BinderTrades;

const item = (extra: Record<string, unknown> = {}) => ({ key: 'k1', cardId: null, look: null, name: 'Pikachu', grader: 'Raw', grade: '', value: '5', valueFrom: '', pct: '', ...extra });
const trade = (id: string, n: number, version = 0, extra: Partial<T> = {}): T => ({ ...B.blank(n), id, version, ...extra });
const view = (id: string, number: number, version: number, customer = ''): View => ({ id, number, customer, dealer: { pct: '100', cash: '', items: [] }, mine: { pct: '100', cash: '', items: [] }, version });
const turn = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

describe('a trade and its tab', () => {
  it('starts blank and empty', () => {
    const t = B.blank(2);
    expect(t).toMatchObject({ id: null, n: 2, customer: '', version: 0, dealer: { pct: '100', cash: '', items: [] } });
    expect(B.isEmpty(t)).toBe(true);
  });

  it('is not empty with a customer, a card, cash or another percentage', () => {
    expect(B.isEmpty({ ...B.blank(1), customer: 'Ash' })).toBe(false);
    const withCard = B.blank(1); withCard.mine.items.push(item());
    expect(B.isEmpty(withCard)).toBe(false);
    const withCash = B.blank(1); withCash.dealer.cash = '5';
    expect(B.isEmpty(withCash)).toBe(false);
    const withPct = B.blank(1); withPct.dealer.pct = '80';
    expect(B.isEmpty(withPct)).toBe(false);
    const sameCash = B.blank(1); sameCash.dealer.cash = '  ';
    expect(B.isEmpty(sameCash)).toBe(true);
  });

  it('is labelled by its customer, else its number', () => {
    expect(B.label({ n: 3, customer: '' })).toBe('Trade 3');
    expect(B.label({ n: 3, customer: '  Ash ' })).toBe('Ash');
  });

  it('sums up its cards and cash', () => {
    const t = B.blank(1);
    expect(B.summary(t)).toBe('Empty');
    t.dealer.items.push(item());
    expect(B.summary(t)).toBe('1 card');
    t.mine.items.push(item(), item());
    t.dealer.cash = '$30';
    t.mine.cash = '10.5';
    expect(B.summary(t)).toBe('3 cards · $40.50 cash');
    const cashOnly = B.blank(1); cashOnly.mine.cash = '40';
    expect(B.summary(cashOnly)).toBe('$40.00 cash');
  });

  it('numbers a new trade with the lowest free number', () => {
    expect(B.nextNumber([])).toBe(1);
    expect(B.nextNumber([{ n: 1 }, { n: 2 }, { n: 4 }])).toBe(3);
  });

  it('says which trade to show after one closes', () => {
    const l = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(B.afterClose(l, 'a')).toBe('b');
    expect(B.afterClose(l, 'b')).toBe('c');
    expect(B.afterClose(l, 'c')).toBe('b');
    expect(B.afterClose([{ id: 'a' }], 'a')).toBeNull();
  });
});

describe('what a save sends', () => {
  it('has the base version and the trade without the page\'s own keys', () => {
    const t = trade('x', 1, 3, { customer: ' Ash ' });
    t.dealer.items.push(item({ key: 'k9', lookState: { busy: true, error: '' } }));
    const w = B.toWire(t);
    expect(w.baseVersion).toBe(3);
    expect(w.customer).toBe('Ash');
    expect(w.dealer.items).toHaveLength(1);
    expect(w.dealer.items[0]).not.toHaveProperty('key');
    expect(w.dealer.items[0]).not.toHaveProperty('lookState');
    expect(w.dealer.items[0]).toMatchObject({ name: 'Pikachu', value: '5' });
    expect(Object.keys(w).sort()).toEqual(['baseVersion', 'customer', 'dealer', 'mine']);
    expect(t.dealer.items[0]).toHaveProperty('key');
  });
});

describe('the trade an earlier version kept', () => {
  it('becomes a new trade', () => {
    const saved = { dealer: { pct: '80', cash: '', items: [{ name: 'Mew', value: '10', grader: 'Raw' }] }, mine: { pct: '100', cash: '5', items: [] } };
    const t = B.fromLegacy(saved, 2, null, ['Raw', 'PSA']);
    expect(t).toMatchObject({ id: null, n: 2, version: 0, customer: '' });
    expect(t?.dealer.pct).toBe('80');
    expect(t?.dealer.items[0]).toMatchObject({ name: 'Mew', value: '10' });
    expect(t?.mine.cash).toBe('5');
  });

  it('is nothing when it has nothing in it', () => {
    expect(B.fromLegacy(null, 1, null, [])).toBeNull();
    expect(B.fromLegacy({}, 1, null, [])).toBeNull();
    expect(B.fromLegacy({ dealer: { pct: '100', cash: '', items: [] } }, 1, null, [])).toBeNull();
    expect(B.fromLegacy('x', 1, null, [])).toBeNull();
  });

  it('drops my cards that are gone', () => {
    const saved = { mine: { items: [{ cardId: 'gone', name: 'A' }, { cardId: 'here', name: 'B' }] } };
    const t = B.fromLegacy(saved, 1, new Set(['here']), ['Raw']);
    expect(t?.mine.items.map((i) => i['name'])).toEqual(['B']);
  });
});

describe('this device\'s trades against the server\'s', () => {
  it('takes a trade only the server has', () => {
    const r = B.reconcile([], [view('s', 2, 4, 'Ash')], new Set());
    expect(r.trades).toMatchObject([{ id: 's', n: 2, version: 4, customer: 'Ash' }]);
    expect(r.conflicts).toEqual([]);
    expect(r.closed).toEqual([]);
  });

  it('takes the server\'s when nothing is unsaved here', () => {
    const r = B.reconcile([trade('a', 1, 2, { customer: 'old' })], [view('a', 1, 5, 'new')], new Set());
    expect(r.trades[0]).toMatchObject({ customer: 'new', version: 5 });
    expect(r.conflicts).toEqual([]);
  });

  it('keeps this trade when the server\'s list is older (fetched before a save)', () => {
    const mine = trade('a', 1, 4, { customer: 'latest' });
    const r = B.reconcile([mine], [view('a', 1, 3, 'older')], new Set());
    expect(r.trades).toEqual([mine]);
    expect(r.conflicts).toEqual([]);
  });

  it('does not call a trade closed when it was first saved after the list was asked for', () => {
    const saved = trade('n', 1, 1, { customer: 'x' });
    const r = B.reconcile([saved], [], new Set(), new Map([['n', 0]]));
    expect(r.trades).toEqual([saved]);
    expect(r.closed).toEqual([]);
    const r2 = B.reconcile([saved], [], new Set(), new Map([['n', 1]]));
    expect(r2.closed).toEqual([saved]);
  });

  it('keeps an unsaved trade that starts from the server\'s version', () => {
    const mine = trade('a', 1, 3, { customer: 'mine' });
    const r = B.reconcile([mine], [view('a', 1, 3, 'theirs')], new Set(['a']));
    expect(r.trades[0]).toBe(mine);
    expect(r.conflicts).toEqual([]);
  });

  it('takes the server\'s and reports a conflict when it moved on from an unsaved trade', () => {
    const mine = trade('a', 1, 3, { customer: 'mine' });
    const r = B.reconcile([mine], [view('a', 1, 4, 'theirs')], ['a']);
    expect(r.trades[0]).toMatchObject({ customer: 'theirs', version: 4 });
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]?.id).toBe('a');
    expect(r.conflicts[0]?.mine).toBe(mine);
  });

  it('keeps a new trade the server hasn\'t seen', () => {
    const fresh = trade('n', 2, 0, { customer: 'new' });
    const r = B.reconcile([fresh], [], new Set(['n']));
    expect(r.trades).toEqual([fresh]);
    expect(r.closed).toEqual([]);
  });

  it('drops a trade that was saved before but is gone from the server, and reports it', () => {
    const gone = trade('g', 1, 2);
    const r = B.reconcile([gone], [], new Set(['g']));
    expect(r.trades).toEqual([]);
    expect(r.closed).toEqual([gone]);
  });

  it('gives a new trade the next free number when the server\'s trade has its number', () => {
    const fresh = trade('n', 1, 0, { customer: 'new' });
    const r = B.reconcile([fresh], [view('s', 1, 2)], new Set(['n']));
    expect(r.trades.map((t) => [t.id, t.n])).toEqual([['s', 1], ['n', 2]]);
  });

  it('lists them in number order', () => {
    const r = B.reconcile([], [view('b', 2, 1), view('a', 1, 1), view('c', 3, 1)], []);
    expect(r.trades.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });
});

/** A clock that only moves when told to, so waits are the test's to end. */
function fake() {
  const waits: { ms: number; end: () => void }[] = [];
  const wait = (ms: number) => new Promise<void>((end) => { waits.push({ ms, end }); });
  const advance = async () => { const w = waits.splice(0); w.forEach((x) => x.end()); await turn(); };
  return { wait, waits, advance };
}
const netErr = () => Object.assign(new Error('down'), { code: 'unavailable' }) as Err;

function setup(over: Partial<SaverOptions> = {}) {
  const clock = fake();
  const sent: { id: string; wire: ReturnType<Trades['toWire']> }[] = [];
  const events: string[] = [];
  let version = 0;
  const put = over.put ?? (async (id: string, wire: unknown) => { sent.push({ id, wire: wire as ReturnType<Trades['toWire']> }); version++; return view(id, 1, version); });
  const saver = B.createSaver({
    put, del: async () => undefined, wait: clock.wait, delayMs: 1000, retryMs: [5000, 15000],
    onSaved: (id, v) => { events.push(`saved ${id} v${v.version}`); target.version = v.version; },
    onConflict: (id) => events.push(`conflict ${id}`),
    onClosed: (id) => events.push(`closed ${id}`),
    onFull: (id) => events.push(`full ${id}`),
    onInvalid: (id) => events.push(`invalid ${id}`),
    onDenied: (id) => events.push(`denied ${id}`),
    ...over,
  });
  const target = trade('a', 1, 0);
  return { saver, clock, sent, events, target, setVersion: (v: number) => { version = v; } };
}

describe('saving trades', () => {
  it('saves a moment after the last change, as one request', async () => {
    const { saver, clock, sent, target } = setup();
    saver.changed(target); await turn();
    target.customer = 'A'; saver.changed(target); await turn();
    target.customer = 'As'; saver.changed(target); await turn();
    expect(saver.status('a')).toBe('saving');
    expect(clock.waits[0]?.ms).toBe(1000);
    await clock.advance();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.wire).toMatchObject({ customer: 'As', baseVersion: 0 });
    expect(saver.status('a')).toBe('saved');
  });

  it('keeps one request in flight per trade and sends a newer edit after it, from the version just saved', async () => {
    const releases: (() => void)[] = [];
    const sent: unknown[] = [];
    let v = 0;
    const { saver, clock, target, events } = setup({
      put: (id, wire) => new Promise<View>((res) => { sent.push(wire); releases.push(() => res(view(id, 1, ++v))); }),
    });
    target.customer = 'one'; saver.changed(target); await turn();
    await clock.advance();
    expect(sent).toHaveLength(1);
    target.customer = 'two'; saver.changed(target); await turn();
    await clock.advance();
    expect(sent).toHaveLength(1);
    expect(saver.status('a')).toBe('saving');
    releases[0]?.(); await turn();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ customer: 'two', baseVersion: 1 });
    releases[1]?.(); await turn();
    expect(saver.status('a')).toBe('saved');
    expect(events).toEqual(['saved a v1', 'saved a v2']);
  });

  it('saves different trades side by side', async () => {
    const { saver, clock, sent } = setup();
    saver.changed(trade('a', 1)); saver.changed(trade('b', 2)); await turn();
    await clock.advance();
    expect(sent.map((s) => s.id).sort()).toEqual(['a', 'b']);
  });

  it('reports a trade changed elsewhere', async () => {
    const { saver, clock, events, target } = setup({ put: async () => { throw Object.assign(new Error('x'), { code: 'trade_changed' }); } });
    saver.changed(target); await turn(); await clock.advance();
    expect(events).toEqual(['conflict a']);
    expect(saver.status('a')).toBe('unsaved');
    expect(clock.waits).toEqual([]);
  });

  it('does not retry a trade the server refuses, and tries again once it changes', async () => {
    let calls = 0;
    const { saver, clock, events, target } = setup({ put: async (id) => { calls++; if (calls === 1) throw Object.assign(new Error('x'), { code: 'invalid_argument' }); return view(id, 1, 1); } });
    saver.changed(target); await turn(); await clock.advance();
    expect(events).toEqual(['invalid a']);
    expect(saver.status('a')).toBe('invalid');
    expect(calls).toBe(1);
    target.customer = 'x'; saver.changed(target); await turn();
    expect(saver.status('a')).toBe('saving');
    await clock.advance();
    expect(calls).toBe(2);
    expect(saver.status('a')).toBe('saved');
  });

  it('does not retry a trade this account may not save (403), and tries again once it changes or on retryAll', async () => {
    let calls = 0, allowed = false;
    const { saver, clock, events, target } = setup({ put: async (id) => { calls++; if (!allowed) throw Object.assign(new Error('You have view-only access.'), { code: 'forbidden' }); return view(id, 1, calls); } });
    saver.changed(target); await turn(); await clock.advance();
    expect(events).toEqual(['denied a']);
    expect(saver.status('a')).toBe('denied');
    expect(calls).toBe(1);
    expect(clock.waits).toEqual([]);
    target.customer = 'x'; saver.changed(target); await turn();
    expect(saver.status('a')).toBe('saving');
    await clock.advance();
    expect(calls).toBe(2);
    expect(saver.status('a')).toBe('denied');
    expect(clock.waits).toEqual([]);
    allowed = true;
    saver.retryAll(); await turn();
    expect(calls).toBe(3);
    expect(saver.status('a')).toBe('saved');
  });

  it('stops on a signed-out answer (runtime.js not_granted) too', async () => {
    let calls = 0;
    const { saver, clock, events, target } = setup({ put: async () => { calls++; throw Object.assign(new Error('Please sign in'), { code: 'not_granted' }); } });
    saver.changed(target); await turn(); await clock.advance();
    expect(events).toEqual(['denied a']);
    expect(saver.status('a')).toBe('denied');
    await clock.advance();
    expect(calls).toBe(1);
  });

  it('reports a trade closed elsewhere and forgets it', async () => {
    const { saver, clock, events, target } = setup({ put: async () => { throw Object.assign(new Error('x'), { code: 'trade_closed' }); } });
    saver.changed(target); await turn(); await clock.advance();
    expect(events).toEqual(['closed a']);
    expect(saver.status('a')).toBe('saved');
  });

  it('reports too many open trades', async () => {
    const { saver, clock, events, target } = setup({ put: async () => { throw Object.assign(new Error('x'), { code: 'too_many_trades' }); } });
    saver.changed(target); await turn(); await clock.advance();
    expect(events).toEqual(['full a']);
  });

  it('is unsaved while the server can\'t be reached, then saves by itself', async () => {
    let down = true, calls = 0;
    const statuses: string[] = [];
    const { saver, clock, events, target } = setup({
      put: async (id) => { calls++; if (down) throw netErr(); return view(id, 1, 1); },
      onStatus: (id) => statuses.push(saver.status(id)),
    });
    target.customer = 'Ash'; saver.changed(target); await turn();
    await clock.advance();
    expect(calls).toBe(1);
    expect(saver.status('a')).toBe('unsaved');
    expect(clock.waits.map((w) => w.ms)).toEqual([5000]);
    await clock.advance();
    expect(calls).toBe(2);
    expect(clock.waits.map((w) => w.ms)).toEqual([15000]);
    down = false;
    await clock.advance();
    expect(calls).toBe(3);
    expect(saver.status('a')).toBe('saved');
    expect(events).toEqual(['saved a v1']);
    expect(statuses).toContain('unsaved');
    expect(statuses.at(-1)).toBe('saved');
  });

  it('does not send a request per edit while it is waiting to try again', async () => {
    let calls = 0;
    const { saver, clock, target } = setup({ put: async () => { calls++; throw netErr(); } });
    saver.changed(target); await turn(); await clock.advance();
    for (let i = 0; i < 5; i++) { target.customer += 'x'; saver.changed(target); await turn(); }
    expect(calls).toBe(1);
  });

  it('retryAll tries again at once', async () => {
    let down = true, calls = 0;
    const { saver, clock, target } = setup({ put: async (id) => { calls++; if (down) throw netErr(); return view(id, 1, 1); } });
    saver.changed(target); await turn(); await clock.advance();
    down = false;
    saver.retryAll(); await turn();
    expect(calls).toBe(2);
    expect(saver.status('a')).toBe('saved');
  });

  it('discarding cancels a save that is waiting, and takes the trade off the server', async () => {
    const deleted: string[] = [];
    const { saver, clock, sent, target } = setup({ del: async (id) => { deleted.push(id); } });
    saver.changed(target); await turn();
    expect(await saver.discard('a')).toBe(true);
    await clock.advance();
    expect(sent).toEqual([]);
    expect(deleted).toEqual(['a']);
  });

  it('discarding waits for a save on its way, then deletes', async () => {
    const log: string[] = [];
    let release = () => {};
    const { saver, clock, target } = setup({
      put: (id) => new Promise<View>((res) => { log.push('put'); release = () => { log.push('put done'); res(view(id, 1, 1)); }; }),
      del: async () => { log.push('del'); },
    });
    saver.changed(target); await turn(); await clock.advance();
    const d = saver.discard('a'); await turn();
    expect(log).toEqual(['put']);
    release(); expect(await d).toBe(true);
    expect(log).toEqual(['put', 'put done', 'del']);
  });

  it('keeps trying to discard while the server can\'t be reached', async () => {
    let down = true, calls = 0;
    const { saver, clock } = setup({ del: async () => { calls++; if (down) throw netErr(); } });
    const d = saver.discard('a'); await turn();
    expect(calls).toBe(1);
    await clock.advance();
    expect(calls).toBe(2);
    down = false; await clock.advance();
    expect(await d).toBe(true);
    expect(calls).toBe(3);
  });

  it('stops trying to discard when this account may not (403 or 401), resolving null', async () => {
    for (const code of ['forbidden', 'not_granted', 'signin']) {
      let calls = 0;
      const { saver, clock } = setup({ del: async () => { calls++; throw Object.assign(new Error('no'), { code }); } });
      expect(await saver.discard('a')).toBe(null);
      await clock.advance();
      expect(calls).toBe(1);
      expect(clock.waits).toEqual([]);
    }
  });

  it('settle sends what is waiting and resolves once it is saved', async () => {
    const { saver, sent, target } = setup();
    target.customer = 'Ash'; saver.changed(target); await turn();
    await saver.settle('a');
    expect(sent).toHaveLength(1);
    expect(saver.status('a')).toBe('saved');
  });

  it('settle waits for a save on its way', async () => {
    let release = () => {};
    let settled = false;
    const { saver, clock, target } = setup({ put: (id) => new Promise<View>((res) => { release = () => res(view(id, 1, 1)); }) });
    saver.changed(target); await turn(); await clock.advance();
    const s = saver.settle('a').then(() => { settled = true; });
    await turn();
    expect(settled).toBe(false);
    release(); await s;
    expect(settled).toBe(true);
  });

  it('settle gives up when the server doesn\'t answer', async () => {
    const { saver, target } = setup({ put: async () => { throw netErr(); } });
    saver.changed(target); await turn();
    await saver.settle('a');
    expect(saver.status('a')).toBe('unsaved');
  });

  it('settle on an unknown trade returns at once', async () => {
    const { saver } = setup();
    await saver.settle('nope');
  });

  it('forget stops saving it', async () => {
    const { saver, clock, sent, target } = setup();
    saver.changed(target); await turn();
    saver.forget('a');
    await clock.advance();
    expect(sent).toEqual([]);
  });
});
