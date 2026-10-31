import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OpenGuestPicture } from '#application/guests/open-guest-picture.ts';
import type { DocumentView } from '#application/ledger/ledger-reader.ts';
import { setUpGuests } from './fixtures.ts';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PHOTO = 'a'.repeat(32);

describe('guests signing in', () => {
  it('only while guest viewing is on, and with the QR code that works now', async () => {
    const t = setUpGuests();
    assert.deepEqual(await t.visit('Ash', 'ash@pallet.town'), { ok: false, error: { code: 'GUESTS_CLOSED' } });
    assert.deepEqual(await t.use.status.execute({ key: 'the-key' }), { open: false, keyOk: true });
    await t.use.setViewing.execute({ actor: 'admin', enabled: true });
    assert.deepEqual(await t.visit('Ash', 'ash@pallet.town', 'wrong'), { ok: false, error: { code: 'WRONG_GUEST_KEY' } });
    assert.deepEqual(await t.use.status.execute({ key: 'wrong' }), { open: true, keyOk: false });
    assert.deepEqual(await t.use.status.execute({ key: '' }), { open: true, keyOk: null });
    const r = await t.visit('  Ash   Ketchum ', ' ash@pallet.town ');
    assert.ok(r.ok);
    assert.deepEqual(r.value.guest, { id: r.value.guest.id, name: 'Ash Ketchum', contact: 'ash@pallet.town' });
    assert.deepEqual(await t.use.identify.execute({ token: r.value.token, touch: true }), { ...r.value.guest, expiresAt: '2026-10-05T18:15:00.000Z' });
    assert.deepEqual(t.logged.auth, ['Guest Ash Ketchum signed in']);
  });

  it('checks the name and contact', async () => {
    const t = setUpGuests();
    await t.use.setViewing.execute({ actor: 'admin', enabled: true });
    assert.deepEqual(await t.visit(' ', 'ash@pallet.town'), { ok: false, error: { code: 'GUEST_NAME_MISSING' } });
    assert.deepEqual(await t.visit('Ash', ''), { ok: false, error: { code: 'GUEST_CONTACT_MISSING' } });
    assert.deepEqual(await t.visit('Ash', 'call me'), { ok: false, error: { code: 'NOT_PHONE_OR_EMAIL' } });
  });

  it('lets several guests in, each with their own name and contact; the same guest again carries on', async () => {
    const t = setUpGuests();
    await t.use.setViewing.execute({ actor: 'admin', enabled: true });
    const ash = await t.signedIn('Ash Ketchum', '604-555-0199');
    await t.signedIn('Misty', 'misty@cerulean.gym');
    assert.deepEqual(await t.visit('ash  ketchum', 'other@mail.com'), { ok: false, error: { code: 'GUEST_NAME_TAKEN' } });
    assert.deepEqual(await t.visit('Gary', '+1 (604) 555 0199'), { ok: false, error: { code: 'GUEST_CONTACT_TAKEN', kind: 'phone' } });
    const again = await t.signedIn('Ash Ketchum', '6045550199');
    assert.ok(await t.use.identify.execute({ token: again, touch: true }));
    assert.equal(await t.use.identify.execute({ token: ash, touch: true }), null);
    const seen = await t.overview();
    assert.deepEqual(seen.active.map((g) => g.name).sort(), ['Ash Ketchum', 'Misty']);
    assert.deepEqual(seen.log.map((v) => [v.name, v.ended]), [['Ash Ketchum', null], ['Misty', null], ['Ash Ketchum', 'replaced']]);
    await t.use.signOut.execute({ token: again });
    assert.equal((await t.visit('Ash Ketchum', 'other@mail.com')).ok, true);
  });

  it('signs a guest out after 15 minutes without use; checks that don\'t count as use keep it short', async () => {
    const t = setUpGuests();
    await t.use.setViewing.execute({ actor: 'admin', enabled: true });
    const token = await t.signedIn('Brock', 'brock@pewter.gym');
    t.clock.at += 14 * 60_000;
    assert.ok(await t.use.identify.execute({ token, touch: true }));
    t.clock.at += 14 * 60_000;
    assert.ok(await t.use.identify.execute({ token, touch: false }));
    t.clock.at += 60_000;
    assert.equal(await t.use.identify.execute({ token, touch: false }), null);
    const { log } = await t.overview();
    assert.deepEqual(log.map((v) => [v.ended, v.endedAt]), [['timeout', '2026-10-05T18:29:00.000Z']]);
  });

  it('closes idle visits on a sweep, saving the log only when something ended', async () => {
    const t = setUpGuests();
    await t.use.setViewing.execute({ actor: 'admin', enabled: true });
    await t.signedIn('Brock', 'brock@pewter.gym');
    const saves = t.desk.saves;
    await t.use.sweep.execute();
    assert.equal(t.desk.saves, saves);
    t.clock.at += 16 * 60_000;
    await t.use.sweep.execute();
    assert.equal(t.desk.saves, saves + 1);
    assert.deepEqual((await t.overview()).active, []);
  });
});

describe('administering guests', () => {
  it('turns guest viewing off (signing everyone out), makes new keys, ends visits and clears the log', async () => {
    const t = setUpGuests([{ id: 'c1', status: 'listed' }, { id: 'c2', status: 'binder' }]);
    await t.use.setViewing.execute({ actor: 'admin', enabled: true });
    const misty = await t.signedIn('Misty', 'misty@cerulean.gym');
    await t.signedIn('Brock', '604 555 0100');
    const seen = await t.overview();
    assert.equal(seen.url, 'https://binder.test/guest.html?k=the-key');
    assert.equal(seen.qr, '<svg>https://binder.test/guest.html?k=the-key</svg>');
    assert.equal(seen.listed, 1);
    assert.equal(seen.idleMinutes, 15);
    assert.deepEqual(seen.log[0], { ...seen.log[0], name: 'Brock', contact: '604 555 0100', contactKind: 'phone', ended: null });

    await t.use.newKey.execute({ actor: 'admin' });
    const { key } = await t.use.viewing.execute();
    assert.notEqual(key, 'the-key');
    assert.deepEqual(await t.visit('Gary', 'gary@oak.lab', 'the-key'), { ok: false, error: { code: 'WRONG_GUEST_KEY' } });
    assert.ok(await t.use.identify.execute({ token: misty, touch: true }));

    const brock = seen.active.find((g) => g.name === 'Brock');
    assert.ok(brock);
    assert.deepEqual(await t.use.endVisit.execute({ actor: 'admin', id: brock.id }), { ok: true, value: undefined });
    assert.deepEqual(await t.use.endVisit.execute({ actor: 'admin', id: brock.id }), { ok: false, error: { code: 'GUEST_NOT_SIGNED_IN' } });
    assert.deepEqual(await t.use.setViewing.execute({ actor: 'admin', enabled: false }), { enabled: false });
    assert.equal(await t.use.identify.execute({ token: misty, touch: true }), null);
    const after = await t.overview();
    assert.deepEqual(after.active, []);
    assert.deepEqual(Object.fromEntries(after.log.map((v) => [v.name, v.ended])), { Brock: 'admin', Misty: 'closed' });
    assert.deepEqual(await t.use.clearLog.execute({ actor: 'admin' }), { removed: 2 });
    assert.deepEqual((await t.overview()).log, []);
    assert.deepEqual(t.logged.admin, [
      'admin turned guest viewing on',
      'admin made a new guest QR code; older ones no longer work',
      'admin signed out the guest Brock',
      'admin turned guest viewing off',
      'admin cleared the guest log (2 visits)',
    ]);
  });

  it('clears the visits of guests whose time ran out since the last sweep', async () => {
    const t = setUpGuests();
    await t.use.setViewing.execute({ actor: 'admin', enabled: true });
    await t.signedIn('Brock', 'brock@pewter.gym');
    await t.signedIn('Misty', 'misty@cerulean.gym');
    t.clock.at += 10 * 60_000;
    const misty = await t.signedIn('Misty Again', 'misty2@cerulean.gym');
    t.clock.at += 6 * 60_000; // Brock and Misty's time ran out; no sweep has run since
    assert.ok(await t.use.identify.execute({ token: misty, touch: false }));
    assert.deepEqual(await t.use.clearLog.execute({ actor: 'admin' }), { removed: 2 });
    assert.deepEqual((await t.desk.read()).book.log.map((v) => v.name), ['Misty Again']);
  });

  it("doesn't log turning guest viewing on when it already is", async () => {
    const t = setUpGuests();
    await t.use.setViewing.execute({ actor: 'admin', enabled: false });
    assert.deepEqual(t.logged.admin, []);
  });
});

describe('what guests see', () => {
  const listed = (over: Record<string, unknown>): DocumentView => ({ id: 'c1', status: 'listed', name: 'Charizard ex', owner: 'Justin', notes: 'Bought from Dave', prices: [{ type: 'market', amount: 1000, currency: 'USD', date: '2026-10-01' }], ...over });

  it('shows the price set for guests instead of the market value', async () => {
    const t = setUpGuests([listed({ guestPrice: 3 })], [{ id: 'main', usdToCad: 1.37 }]);
    assert.deepEqual((await t.use.listCards.execute()).map((c) => [c.id, c.value]), [['c1', 3]]);
  });

  it('is the cards listed for sale (no placeholders), valued at the ledger\'s rate', async () => {
    const t = setUpGuests([listed({}), listed({ id: 'ph', placeholder: true }), listed({ id: 'kept', status: 'binder' })], [{ id: 'main', usdToCad: 1.37 }]);
    const cards = await t.use.listCards.execute();
    assert.deepEqual(cards.map((c) => [c.id, c.value]), [['c1', 1370]]);
    assert.doesNotMatch(JSON.stringify(cards), /Justin|Dave/);
  });

  it('is their pictures: photos and inline ones, for listed cards only', async () => {
    const t = setUpGuests([listed({ imageId: PHOTO }), listed({ id: 'c2', imageId: `data:image/png;base64,${Buffer.from('png bytes').toString('base64')}` }), listed({ id: 'kept', status: 'binder', imageId: PHOTO }), listed({ id: 'gone', imageId: 'b'.repeat(32) })]);
    await t.photos.save(PHOTO as never, JPEG);
    const photo = await t.use.openPicture.execute({ cardId: 'c1' });
    assert.equal(photo?.kind, 'photo');
    const inline = await t.use.openPicture.execute({ cardId: 'c2' });
    assert.ok(inline?.kind === 'inline');
    assert.equal(inline.type, 'image/png');
    assert.equal(Buffer.from(inline.bytes).toString(), 'png bytes');
    assert.equal(await t.use.openPicture.execute({ cardId: 'kept' }), null);
    assert.equal(await t.use.openPicture.execute({ cardId: 'gone' }), null);
    assert.equal(await t.use.openPicture.execute({ cardId: '../c1' }), null);
  });

  it('looks up only the card whose picture is asked for', async () => {
    const t = setUpGuests([listed({ imageId: PHOTO })]);
    await t.photos.save(PHOTO as never, JPEG);
    const asked: string[] = [];
    const open = new OpenGuestPicture({ ...t.deps, cards: { card: async (id) => (asked.push(id), t.deps.cards.card(id)) } });
    assert.equal((await open.execute({ cardId: 'c1' }))?.kind, 'photo');
    assert.deepEqual(asked, ['c1']);
  });
});
