import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nameKey, parseContact, readContactText, readGuestName } from '#domain/guests/contact.ts';
import { guestCard, guestPlace, guestValue, setGuestPrice, shownImage, type CardRecord } from '#domain/guests/guest-card.ts';
import { admitGuest, clearLog, closeOpenVisits, endVisit, type GuestBook, type GuestSession, type GuestVisit, logVisit, MAX_GUEST_LOG } from '#domain/guests/visits.ts';

const NOW = new Date('2026-10-05T18:00:00.000Z');
const price = (over: Record<string, unknown>) => ({ type: 'market', amount: 10, currency: 'CAD', date: '2026-10-01', at: '2026-10-01T12:00:00Z', ...over });
/** Prices as they are: the condition adjustment is the page's own (tested with it in tests/infrastructure). */
const asIs = (_card: CardRecord, p: Readonly<Record<string, unknown>>) => (typeof p['amount'] === 'number' ? p['amount'] : null);
const card = (over: Record<string, unknown>): CardRecord => ({ id: 'c1', ...over });

describe('who a guest is', () => {
  it('compares names without case or extra spaces', () => {
    assert.equal(nameKey('  Ash   KETCHUM '), 'ash ketchum');
    assert.deepEqual(readGuestName('  Ash   Ketchum '), { ok: true, value: 'Ash Ketchum' });
    assert.deepEqual(readGuestName(' '), { ok: false, error: { code: 'GUEST_NAME_MISSING' } });
    assert.deepEqual(readGuestName('x'.repeat(81)), { ok: false, error: { code: 'GUEST_NAME_TOO_LONG' } });
    assert.deepEqual(readContactText(' '), { ok: false, error: { code: 'GUEST_CONTACT_MISSING' } });
    assert.deepEqual(readContactText('x'.repeat(121)), { ok: false, error: { code: 'GUEST_CONTACT_TOO_LONG' } });
  });

  it('takes an email or a phone number, and compares phone numbers by their digits', () => {
    assert.deepEqual(parseContact(' Ash@Pallet.town '), { ok: true, value: { kind: 'email', key: 'ash@pallet.town', display: 'Ash@Pallet.town' } });
    const key = (raw: string) => {
      const r = parseContact(raw);
      return r.ok ? r.value.key : r.error.code;
    };
    assert.equal(key('(604) 555-0199'), '6045550199');
    assert.equal(key('+1 604 555 0199'), '6045550199');
    assert.equal(key('ash@'), 'INVALID_EMAIL');
    assert.equal(key('12'), 'INVALID_PHONE');
    assert.equal(key('call me'), 'NOT_PHONE_OR_EMAIL');
  });
});

describe('what guests see of a card', () => {
  it("is the ledger's market value, rounded up to the dollar", () => {
    assert.equal(guestValue(card({ prices: [price({ amount: 20.2 })] }), 1.37, asIs), 21);
    assert.equal(guestValue(card({ prices: [price({ amount: 21 })] }), 1.37, asIs), 21);
    // the newest market price or sold comp; what was paid and listing prices don't count
    assert.equal(guestValue(card({ prices: [price({ amount: 5, date: '2026-09-01' }), price({ type: 'comp', amount: 7.5, date: '2026-09-20' }), price({ type: 'paid', amount: 100, date: '2026-10-02' })] }), 1.37, asIs), 8);
    assert.equal(guestValue(card({ prices: [price({ amount: 10, currency: 'USD' })] }), 1.37, asIs), 14);
    assert.equal(guestValue(card({ prices: [price({ type: 'paid' })] }), 1.37, asIs), null);
    assert.equal(guestValue(card({}), 1.37, asIs), null);
  });

  it('is the price the person set for guests, to the cent, when there is one', () => {
    const prices = [price({ amount: 20.2 })];
    assert.equal(guestValue(card({ prices, guestPrice: 3 }), 1.37, asIs), 3);
    assert.equal(guestValue(card({ prices, guestPrice: 2.5 }), 1.37, asIs), 2.5);
    assert.equal(guestValue(card({ guestPrice: 4 }), 1.37, asIs), 4);
    for (const bad of [0, -1, Number.NaN, '3', null]) assert.equal(guestValue(card({ prices, guestPrice: bad }), 1.37, asIs), 21);
    assert.equal(setGuestPrice(card({ guestPrice: 3 })), 3);
    assert.equal(setGuestPrice(card({})), null);
    assert.ok(!Object.keys(guestCard(card({ guestPrice: 3 }), 1.37, asIs, () => 'v', () => undefined)).includes('guestPrice'));
  });

  it('is only its details, value and picture', () => {
    const c = guestCard(card({ name: 'Lapras', set: '30th Celebration', status: 'listed', owner: 'Megan', notes: 'secret', binderId: 'b1', page: 2, slot: 3, prices: [price({ type: 'paid' })], imageId: 'abc', sale: { soldCAD: 5 } }), 1.37, asIs, () => '0123456789ab', (id) => (id === 'b1' ? { id: 'b1', name: 'Trade', owner: 'Megan', color: '#2F6FD8', pockets: 12, layout: { places: [{ id: 'c1', page: 9, slot: 9 }] } } : undefined));
    assert.deepEqual(Object.keys(c).sort(), ['artist', 'condition', 'grade', 'grader', 'id', 'image', 'language', 'name', 'number', 'place', 'rarity', 'released', 'set', 'setCode', 'value', 'variant'].sort());
    assert.deepEqual(c.place, { binderId: 'b1', binder: 'Trade', color: '#2F6FD8', kind: 'binder', order: 0, pockets: 12, page: 2, pocket: 3 });
    assert.doesNotMatch(JSON.stringify(c), /Megan|layout/);
    assert.match(c.image ?? '', /^api\/guest\/cards\/c1\/image\?v=[0-9a-f]{12}$/);
  });

  describe('where it is', () => {
    const inB1 = card({ binderId: 'b1', page: 2, slot: 3 });
    const binder = (over: Record<string, unknown> = {}) => ({ id: 'b1', name: 'Trade', pockets: 9, ...over });

    it('has no page or pocket in a display case', () => {
      assert.deepEqual(guestPlace(inB1, binder({ kind: 'case', pockets: 12 })), { binderId: 'b1', binder: 'Trade', color: null, kind: 'case', order: 0, pockets: null, page: null, pocket: null });
    });

    it('is nothing without a binder, or with another one', () => {
      assert.equal(guestPlace(inB1, undefined), null);
      assert.equal(guestPlace(card({}), binder()), null);
      assert.equal(guestPlace(card({ binderId: '' }), binder()), null);
      assert.equal(guestPlace(inB1, binder({ id: 'b2' })), null);
    });

    it('is nothing in a binder hidden from guests', () => {
      assert.equal(guestPlace(inB1, binder({ hiddenFromGuests: true })), null);
      assert.equal(guestPlace(inB1, binder({ hiddenFromGuests: false }))?.binder, 'Trade');
      assert.equal(guestPlace(inB1, binder())?.binder, 'Trade');
    });

    it('falls back to safe values for a binder', () => {
      assert.equal(guestPlace(inB1, binder({ pockets: 7 }))?.pockets, 9);
      assert.equal(guestPlace(inB1, { id: 'b1', name: 'Trade' })?.pockets, 9);
      assert.equal(guestPlace(inB1, binder({ color: 'red;x' }))?.color, null);
      assert.equal(guestPlace(inB1, binder({ color: '#abc' }))?.color, '#abc');
      assert.equal(guestPlace(inB1, binder({ name: '' }))?.binder, 'Binder');
      assert.equal(guestPlace(inB1, binder({ order: 4 }))?.order, 4);
      assert.equal(guestPlace(inB1, binder({ order: 'x' }))?.order, 0);
    });

    it('has no page or pocket that is not a whole number above zero', () => {
      const p = guestPlace(card({ binderId: 'b1', page: 1.5, slot: 0 }), binder());
      assert.equal(p?.page, null);
      assert.equal(p?.pocket, null);
      assert.equal(guestPlace(card({ binderId: 'b1' }), binder())?.page, null);
    });
  });

  it("shows the official picture unless the person picked their own photo", () => {
    assert.equal(shownImage(card({ officialImageId: 'o', imageId: 'p' })), 'o');
    assert.equal(shownImage(card({ officialImageId: 'o', imageId: 'p', imagePref: 'photo' })), 'p');
    assert.equal(shownImage(card({ officialImageId: 'o', imagePref: 'photo' })), 'o');
    assert.equal(shownImage(card({})), null);
  });
});

describe('guest visits', () => {
  const contact = { kind: 'email' as const, key: 'ash@pallet.town', display: 'ash@pallet.town' };
  const session = (over: Partial<GuestSession> = {}): GuestSession => ({ id: 'g1', hash: 'h', name: 'Ash', nameKey: 'ash', contact: 'ash@pallet.town', contactKey: 'ash@pallet.town', contactKind: 'email', ip: '', agent: '', createdAt: NOW.getTime(), lastSeen: NOW.getTime(), ...over });
  const visit = (over: Partial<GuestVisit> = {}): GuestVisit => ({ id: 'g1', name: 'Ash', contact: 'ash@pallet.town', contactKind: 'email', ip: '', agent: '', startedAt: NOW.toISOString(), lastSeenAt: NOW.toISOString(), endedAt: null, ended: null, ...over });
  const book = (log: GuestVisit[]): GuestBook => ({ settings: { enabled: true, key: 'k', keyCreatedAt: NOW.toISOString() }, log });

  it('let no two guests share a name or a contact, and treat the same pair as the same guest', () => {
    const ash = session();
    assert.deepEqual(admitGuest([ash], 'ash', contact), { ok: true, value: ash });
    assert.deepEqual(admitGuest([ash], 'ash', { ...contact, key: 'other' }), { ok: false, error: { code: 'GUEST_NAME_TAKEN' } });
    assert.deepEqual(admitGuest([ash], 'gary', { kind: 'email', key: 'ash@pallet.town', display: '' }), { ok: false, error: { code: 'GUEST_CONTACT_TAKEN', kind: 'email' } });
    assert.deepEqual(admitGuest([ash], 'misty', { kind: 'phone', key: '6045550199', display: '' }), { ok: true, value: null });
  });

  it('end a timed-out visit 15 minutes after its last use', () => {
    const b = book([visit()]);
    endVisit(b, session({ lastSeen: NOW.getTime() + 60_000 }), 'timeout', new Date(NOW.getTime() + 3_600_000));
    assert.deepEqual(b.log[0], visit({ endedAt: '2026-10-05T18:16:00.000Z', ended: 'timeout', lastSeenAt: '2026-10-05T18:01:00.000Z' }));
  });

  it('close the visits that were open when the server restarted', () => {
    const b = book([visit(), visit({ id: 'g2', endedAt: NOW.toISOString(), ended: 'signout' })]);
    assert.equal(closeOpenVisits(b, NOW), 1);
    assert.deepEqual(b.log.map((v) => v.ended), ['restart', 'signout']);
  });

  it('keep the newest visits in the log, and clear all but those of guests looking now', () => {
    const b = book([]);
    for (let i = 0; i < MAX_GUEST_LOG + 5; i++) logVisit(b, visit({ id: `v${i}` }));
    assert.equal(b.log.length, MAX_GUEST_LOG);
    assert.equal(b.log[0]?.id, `v${MAX_GUEST_LOG + 4}`);
    assert.equal(clearLog(b, new Set(['v10'])), MAX_GUEST_LOG - 1);
    assert.deepEqual(b.log.map((v) => v.id), ['v10']);
  });
});
