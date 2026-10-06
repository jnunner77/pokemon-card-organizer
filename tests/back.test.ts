import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/back.js is a plain browser script; load it the way the page does.
type State = Record<string, unknown> | null;
type Back = { sync: (open: boolean) => void; popstate: (state: State) => void };
const sandbox = { window: {} as { BackClose: { create: (history: FakeHistory, onBack: () => void) => Back } } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/back.js'), 'utf8'), sandbox);
const { create } = sandbox.window.BackClose;

/* Like window.history: back() and forward() move later and fire popstate (flushed by settle()). */
class FakeHistory {
  entries: State[];
  i: number;
  queued: State[] = [];
  listener: (s: State) => void = () => {};
  constructor(entries: State[] = [{ page: 'admin' }, null]) { this.entries = entries; this.i = entries.length - 1; }
  get state() { return this.entries[this.i]; }
  get length() { return this.entries.length; }
  pushState(s: State) { this.entries.splice(this.i + 1, Infinity, s); this.i++; }
  replaceState(s: State) { this.entries[this.i] = s; }
  back() { this.go(-1); }
  forward() { this.go(1); }
  go(n: number) { const j = this.i + n; if (j < 0 || j >= this.entries.length) return; this.i = j; this.queued.push(this.state); }
  settle() { while (this.queued.length) this.listener(this.queued.shift()!); }
}

/* a page with a drawer: open/close go through sync like renderDrawer does */
function page(h = new FakeHistory()) {
  const p = { h, open: false, back: null as unknown as Back,
    show(on: boolean) { p.open = on; p.back.sync(on); } };
  p.back = create(h, () => p.show(false));
  h.listener = s => p.back.popstate(s);
  return p;
}

describe('Back closes Card details', () => {
  it('adds one history entry while the drawer is open, and Back closes it without leaving the page', () => {
    const p = page();
    p.show(true);
    expect(p.h.length).toBe(3);
    p.h.back(); p.h.settle();
    expect(p.open).toBe(false);
    expect(p.h.i).toBe(1); // still on the binder, not Administration
    expect(p.h.state).toBe(null);
  });

  it('closing with ✕ takes the entry back off, so the next Back goes where it did before', () => {
    const p = page();
    p.show(true);
    p.show(false); p.h.settle();
    expect(p.h.i).toBe(1);
    p.show(true); p.show(false); p.h.settle();
    expect(p.h.i).toBe(1);
    p.h.back(); p.h.settle();
    expect(p.h.state).toEqual({ page: 'admin' });
  });

  it("doesn't add entries when another card opens while the drawer is open", () => {
    const p = page();
    p.show(true); p.show(true); p.show(true);
    expect(p.h.length).toBe(3);
    p.h.back(); p.h.settle();
    expect(p.open).toBe(false);
    expect(p.h.i).toBe(1);
  });

  it('a card opened before the close has finished still gets its entry, and Back closes it', () => {
    const p = page();
    p.show(true);
    p.show(false); p.show(true); // closed and opened again before popstate arrives
    p.h.settle();
    expect(p.h.i).toBe(2);
    expect(p.h.state).toEqual({ cardDetails: true });
    p.h.back(); p.h.settle();
    expect(p.open).toBe(false);
    expect(p.h.i).toBe(1);
  });

  it('keeps what else the entry holds', () => {
    const p = page(new FakeHistory([{ page: 'admin' }, { scroll: 4 }]));
    p.show(true);
    expect(p.h.state).toEqual({ scroll: 4, cardDetails: true });
    p.show(false); p.h.settle();
    expect(p.h.state).toEqual({ scroll: 4 });
  });

  it('forgets an entry left over from a reload, so the next card adds its own', () => {
    const h = new FakeHistory([{ page: 'admin' }, null, { cardDetails: true }]);
    const p = page(h);
    expect(h.state).toEqual({});
    p.show(true);
    expect(h.state).toEqual({ cardDetails: true });
    h.back(); h.settle();
    expect(p.open).toBe(false);
    expect(h.state).toEqual({});
  });

  it("Forward into a closed drawer's entry doesn't reopen anything or trap Back", () => {
    const p = page();
    p.show(true);
    p.h.back(); p.h.settle();
    p.h.forward(); p.h.settle();
    expect(p.open).toBe(false);
    expect(p.h.state).toEqual({});
    p.show(true);
    expect(p.h.state).toEqual({ cardDetails: true });
  });
});
