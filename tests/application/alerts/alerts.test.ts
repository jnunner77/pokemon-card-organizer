import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { cardDetails, cardLinks } from '#application/alerts/alert-email.ts';
import { CheckWatches } from '#application/alerts/check-watches.ts';
import type { AlertDeps } from '#application/alerts/deps.ts';
import { ReadAlertSettings } from '#application/alerts/read-alert-settings.ts';
import { RemoveAlertSettings } from '#application/alerts/remove-alert-settings.ts';
import { SaveAlertSettings } from '#application/alerts/save-alert-settings.ts';
import { SendTestAlert } from '#application/alerts/send-test-alert.ts';
import { MemoryAdminSettings, MemoryTokenVault } from '#infrastructure/memory/admin.ts';
import { MemoryAlertHistory, MemoryMailer } from '#infrastructure/memory/alerts.ts';
import { MemoryLedger } from '#infrastructure/memory/ledger.ts';
import { Logger } from '#infrastructure/logging/logger.ts';

const ACCOUNT = { gmail: 'me@gmail.com', to: ['me@gmail.com'], link: 'https://binder.example.com' };
const market = (amount: number, date = '2026-10-20', more: Record<string, unknown> = {}) => ({ id: `p${date}${amount}`, type: 'market', amount, currency: 'CAD', date, ...more });

function setUp() {
  let now = new Date('2026-10-20T13:00:00.000Z');
  const ledger = new MemoryLedger();
  const settings = new MemoryAdminSettings();
  const password = new MemoryTokenVault();
  const mailer = new MemoryMailer();
  const history = new MemoryAlertHistory();
  const log = new Logger({ stdout: false, now: () => now });
  const events: unknown[] = [];
  const deps: AlertDeps = {
    settings,
    password,
    mailer,
    history,
    ledger: ledger.reader,
    cards: ledger.cards,
    // Automatic prices for a played card are worth less, as in the page.
    condition: { adjust: (card, price) => (typeof price['amount'] === 'number' ? (price['auto'] && card['condition'] === 'Damaged' ? price['amount'] * 0.15 : price['amount']) : null) },
    unitOfWork: ledger.unitOfWork,
    events: { publish: async (e) => void events.push(...e) },
    clock: { now: () => now },
    log,
  };
  const setUpMail = () => {
    settings.set({ alerts: ACCOUNT });
    password.write('abcdefghijklmnop');
  };
  return { deps, ledger, settings, password, mailer, history, log, events, setUpMail, check: new CheckWatches(deps), later: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

describe('Checking price watches', () => {
  let t: ReturnType<typeof setUp>;
  beforeEach(() => {
    t = setUp();
  });

  it('emails one buy alert and one separate sell alert listing every card that reached its price', async () => {
    t.setUpMail();
    t.ledger.seed('settings', 'main', { usdToCad: 1.4 });
    t.ledger.seed('cards', 'w1', { name: 'Umbreon', set: 'Evolving Skies', number: '215/203', watchlist: true, placeholder: true, watch: { buy: 5 }, prices: [market(4.5)] });
    t.ledger.seed('cards', 'w2', { name: 'Eevee', watch: { buy: 3 }, prices: [{ ...market(2), currency: 'USD' }] }); // US$2 = C$2.80
    t.ledger.seed('cards', 'w3', { name: 'Pikachu', watch: { buy: 1 }, prices: [market(2)] }); // not yet
    t.ledger.seed('cards', 's1', { name: 'Charizard', status: 'binder', watch: { sell: 200 }, prices: [market(250)] });
    t.ledger.seed('cards', 's2', { name: 'Mew', placeholder: true, watch: { sell: 1 }, prices: [market(250)] }); // not owned: never sold

    const r = await t.check.execute();
    assert.deepEqual(r, { buy: 2, sell: 1, notSetUp: false, errors: [] });
    assert.equal(t.mailer.sent.length, 2);
    const [buy, sell] = t.mailer.sent;
    assert.ok(buy && sell);
    assert.equal(buy.message.subject, 'Buy alert: 2 cards at or under your price');
    assert.deepEqual(buy.message.to, ['me@gmail.com']);
    assert.deepEqual(buy.account, { address: 'me@gmail.com', password: 'abcdefghijklmnop' });
    assert.match(buy.message.text, /Umbreon \(Evolving Skies · 215\/203\)\n {3}\$4\.50, your price \$5\.00: \$0\.50 under/);
    assert.match(buy.message.text, /Eevee\n {3}\$2\.80, your price \$3\.00/);
    assert.doesNotMatch(buy.message.text, /Pikachu|Charizard/);
    assert.match(buy.message.html, /Time to buy/);
    assert.match(buy.message.text, /https:\/\/binder\.example\.com\/#watchlist/);
    assert.equal(sell.message.subject, 'Sell alert: Charizard at $250.00 (your price $200.00)');
    assert.match(sell.message.html, /Time to sell/);
    assert.doesNotMatch(sell.message.text, /Mew/);

    // Recorded on the cards, and sent to open pages.
    assert.deepEqual(t.ledger.tables.cards.get('w1')?.['watchAlerts'], { buy: { at: '2026-10-20T13:00:00.000Z', target: 5, price: 4.5 } });
    assert.deepEqual(t.ledger.tables.cards.get('s1')?.['watchAlerts'], { sell: { at: '2026-10-20T13:00:00.000Z', target: 200, price: 250 } });
    assert.equal(t.ledger.tables.cards.get('w3')?.['watchAlerts'], undefined);
    assert.equal(t.events.length, 3);
    assert.deepEqual(t.history.lastSent(), { at: '2026-10-20T13:00:00.000Z', buy: 2, sell: 1, error: null });
  });

  it('emails a card once, and again only after its value moves back and reaches its price again', async () => {
    t.setUpMail();
    t.ledger.seed('cards', 'c1', { name: 'Umbreon', watch: { buy: 5 }, prices: [market(4.5)] });
    await t.check.execute();
    await t.check.execute();
    assert.equal(t.mailer.sent.length, 1);
    // Back over $5: cleared, nothing sent.
    t.ledger.seed('cards', 'c1', { ...t.ledger.tables.cards.get('c1'), prices: [market(4.5), market(6, '2026-10-21')] });
    await t.check.execute();
    assert.equal(t.mailer.sent.length, 1);
    assert.equal(t.ledger.tables.cards.get('c1')?.['watchAlerts'], null);
    // Under again: emailed again.
    t.ledger.seed('cards', 'c1', { ...t.ledger.tables.cards.get('c1'), prices: [market(6, '2026-10-21'), market(4.9, '2026-10-22')] });
    await t.check.execute();
    assert.equal(t.mailer.sent.length, 2);
    assert.match(t.mailer.sent[1]?.message.subject ?? '', /Umbreon at \$4\.90/);
  });

  it('uses the value the binder shows: a played card\'s automatic price is adjusted for its condition', async () => {
    t.setUpMail();
    t.ledger.seed('cards', 'c1', { name: 'Lugia', condition: 'Damaged', watch: { buy: 20 }, prices: [market(100, '2026-10-20', { auto: true })] });
    await t.check.execute();
    assert.match(t.mailer.sent[0]?.message.subject ?? '', /Lugia at \$15\.00/);
  });

  it('records nothing for an email that failed, so it is tried again; the other alert still goes', async () => {
    t.setUpMail();
    t.ledger.seed('cards', 'b', { name: 'Umbreon', watch: { buy: 5 }, prices: [market(4)] });
    t.ledger.seed('cards', 's', { name: 'Charizard', watch: { sell: 5 }, prices: [market(40)] });
    t.mailer.fail = 'connect ETIMEDOUT';
    t.mailer.failOnly = 'Buy alert';
    const r = await t.check.execute();
    assert.equal(r.buy, 0);
    assert.equal(r.sell, 1);
    assert.match(r.errors[0] ?? '', /Couldn't email the buy alert: connect ETIMEDOUT/);
    assert.equal(t.ledger.tables.cards.get('b')?.['watchAlerts'], undefined);
    assert.ok(t.ledger.tables.cards.get('s')?.['watchAlerts']);
    assert.match(t.history.lastError()?.error ?? '', /ETIMEDOUT/);
    assert.ok(t.log.query({ level: 'error' }).some((e) => /buy alert/.test(e.msg)));
    t.mailer.fail = null;
    await t.check.execute();
    assert.equal(t.mailer.sent.at(-1)?.message.subject, 'Buy alert: Umbreon at $4.00 (your price $5.00)');
  });

  it('says so, and sends nothing, when alert emails aren\'t set up', async () => {
    t.ledger.seed('cards', 'c1', { name: 'Umbreon', watch: { buy: 5 }, prices: [market(4)] });
    assert.deepEqual(await t.check.execute(), { buy: 0, sell: 0, notSetUp: true, errors: [] });
    assert.equal(t.ledger.tables.cards.get('c1')?.['watchAlerts'], undefined);
    t.setUpMail();
    assert.equal((await t.check.execute()).buy, 1);
  });

  it('joins a check already running', async () => {
    t.setUpMail();
    t.ledger.seed('cards', 'c1', { name: 'Umbreon', watch: { buy: 5 }, prices: [market(4)] });
    await Promise.all([t.check.execute(), t.check.execute()]);
    assert.equal(t.mailer.sent.length, 1);
  });

  it('lists each card\'s details and where to buy or sell it', () => {
    const card = { name: 'Lapras', set: '30th Celebration', number: '131/128', variant: 'Reverse Holo', grader: 'PSA', grade: '10', pricing: { source: 'pricecharting', url: 'https://www.pricecharting.com/game/x', pair: { source: 'tcgplayer', url: 'https://www.tcgplayer.com/product/1' } } };
    assert.equal(cardDetails(card), '30th Celebration · 131/128 · Reverse Holo · PSA 10');
    assert.deepEqual(
      cardLinks(card, 'buy').map((l) => l.label),
      ['PriceCharting', 'TCGplayer', 'eBay.ca listings'],
    );
    assert.match(cardLinks({ name: 'Mew', pricing: { source: 'tcgplayer', url: 'javascript:alert(1)' } }, 'sell').map((l) => l.url).join(' '), /^https:\/\/www\.ebay\.ca\/sch\/i\.html\?_nkw=Mew&LH_Sold=1/);
  });
});

describe('Setting up price alert emails', () => {
  let t: ReturnType<typeof setUp>;
  beforeEach(() => {
    t = setUp();
  });

  it('saves the account once a test email has gone out with it', async () => {
    const r = await new SaveAlertSettings(t.deps).execute({ actor: 'justin', body: { gmail: 'me@gmail.com', to: 'me@gmail.com, partner@x.ca', password: 'abcd efgh ijkl mnop', link: 'https://binder.example.com' } });
    assert.ok(r.ok);
    assert.deepEqual(r.value.settings, { gmail: 'me@gmail.com', to: ['me@gmail.com', 'partner@x.ca'], link: 'https://binder.example.com' });
    assert.equal(r.value.password.set, true);
    assert.equal(JSON.stringify(r.value).includes('abcdefghijklmnop'), false);
    assert.equal(t.password.read(), 'abcdefghijklmnop');
    assert.equal(t.mailer.sent[0]?.message.subject, 'Price alerts from your binder are working');
    assert.ok(t.log.query().some((e) => /justin set up price alert emails/.test(e.msg)));
  });

  it('doesn\'t save an account Gmail refuses, or one with no app password', async () => {
    t.mailer.refuse = true;
    const refused = await new SaveAlertSettings(t.deps).execute({ actor: 'justin', body: { gmail: 'me@gmail.com', password: 'abcdefghijklmnop' } });
    assert.deepEqual(refused, { ok: false, error: { code: 'MAIL_REFUSED', message: '535 Username and Password not accepted' } });
    assert.equal(t.password.read(), null);
    assert.equal(t.settings.get().alerts, undefined);
    assert.deepEqual(await new SaveAlertSettings(t.deps).execute({ actor: 'justin', body: { gmail: 'me@gmail.com' } }), { ok: false, error: { code: 'APP_PASSWORD_NEEDED' } });
  });

  it('keeps the saved app password when only who it goes to changes', async () => {
    t.setUpMail();
    const r = await new SaveAlertSettings(t.deps).execute({ actor: 'justin', body: { gmail: 'me@gmail.com', to: 'other@x.ca' } });
    assert.ok(r.ok);
    assert.equal(t.mailer.sent[0]?.account.password, 'abcdefghijklmnop');
    assert.deepEqual(t.mailer.sent[0]?.message.to, ['other@x.ca']);
  });

  it('sends a test email, reads back what\'s saved, and turns alerts off', async () => {
    assert.deepEqual(await new SendTestAlert(t.deps).execute({ actor: 'justin' }), { ok: false, error: { code: 'ALERTS_NOT_SET_UP' } });
    t.setUpMail();
    t.ledger.seed('cards', 'c1', { name: 'Umbreon', watch: { buy: 5, sell: 50 } });
    assert.deepEqual(await new SendTestAlert(t.deps).execute({ actor: 'justin' }), { ok: true, value: { to: ['me@gmail.com'] } });
    assert.match(t.mailer.sent[0]?.message.text ?? '', /watching 1 card to buy and 1 card to sell/);
    const view = await new ReadAlertSettings(t.deps).execute();
    assert.deepEqual(view.settings, ACCOUNT);
    assert.deepEqual(view.watching, { buy: 1, sell: 1 });
    const off = await new RemoveAlertSettings(t.deps).execute({ actor: 'justin' });
    assert.equal(off.settings, null);
    assert.equal(off.password.set, false);
  });
});
