// Browser smoke test. Start the app on an empty data directory first:
//   DATA_DIR=$(mktemp -d) AUTH=off PRICE_UPDATES=off npm start
//   BASE_URL=http://localhost:4100/ npm run test:e2e
// It creates a binder and cards, prices, moves and sells one, finds it with Find, checks live
// updates between two tabs, the Pricing and Selling views, a backup download, a display case (the
// card moved in and back out), editing in the Table, the phone layout, and a guest from the QR
// code looking through the cards listed for sale on a phone.
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:4100/';
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const fail = (m) => {
  throw new Error(m);
};
const errors = [];
const watch = (page) => {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
};

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  watch(page);
  await page.goto(BASE);
  await page.getByRole('button', { name: 'Create your first binder' }).click();
  await page.locator('#b_name').fill('Trade binder');
  await page.getByRole('button', { name: 'Create binder' }).click();
  await page.getByText('Trade binder created').waitFor();

  // Add a card in pocket 1.
  await page.locator('[data-empty="1"]').click();
  await page.locator('#f_name').fill('Charizard ex');
  await page.locator('#f_setCode').fill('OBF');
  await page.locator('#f_number').fill('125/197');
  await page.locator('#btnSave').click();
  await page.getByText('Added Charizard ex').waitFor();

  // A second tab sees it live.
  const other = await ctx.newPage();
  watch(other);
  await other.goto(BASE);
  await other.locator('[data-card]').filter({ hasText: 'Charizard ex' }).waitFor();

  // Price it.
  await page.locator('#n_amount').fill('18.50');
  await page.getByRole('button', { name: 'Add entry' }).click();
  await page.getByText('Price added').waitFor();
  await other.locator('.pocket .price', { hasText: '$18.50' }).waitFor();

  // Upload a photo through the file picker (a 1x1 PNG).
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await page.locator('#photoPicker').setInputFiles({ name: 'card.png', mimeType: 'image/png', buffer: png });
  await page.getByText('Photo saved').waitFor();
  const src = await page.locator('#bigImg img').getAttribute('src');
  if (!/^blob\/[a-f0-9]{32}$/.test(src || '')) fail(`photo src ${src}`);
  const img = await page.request.get(new URL(src, BASE).href);
  if (!img.ok()) fail('photo not served');

  // Quick sell.
  await page.locator('#btnQuickSell').click();
  await page.locator('[data-qsamt]').fill('30');
  await page.locator('#qs_go').click();
  await page.getByText(/Sold Charizard ex for \$30\.00/).waitFor();
  await page.getByRole('tab', { name: /Sales/ }).click();
  await page.locator('.salestbl').getByText('Charizard ex').waitFor();

  // Undo puts it back in the binder.
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.getByText(/back in Trade binder/).waitFor();

  // Find it by set code and number: Show in binder highlights its pocket; Full screen opens the viewer.
  await page.getByRole('tab', { name: /Sales/ }).click();
  await page.keyboard.press('/');
  await page.locator('#findQ').fill('obf 125');
  await page.locator('.find-item').filter({ hasText: 'Charizard ex' }).waitFor();
  await page.getByRole('button', { name: 'Show in binder', exact: true }).click();
  await page.locator('.pocket.found').filter({ hasText: 'Charizard ex' }).waitFor();
  await page.getByRole('button', { name: /Find a card/ }).click();
  await page.locator('#findQ').fill('charizard');
  await page.getByRole('button', { name: 'Full screen', exact: true }).click();
  await page.locator('#lbCap').getByText('Charizard ex').waitFor();
  await page.keyboard.press('Escape');

  // Pricing shows the binder's value over the chosen range; a card row opens its details.
  await page.getByRole('button', { name: 'Pricing' }).click();
  await page.locator('#pv_scope').selectOption({ label: 'Trade binder' });
  await page.locator('[data-pvrange="90d"]').click();
  await page.locator('.pv-stats').getByText('$18.50').first().waitFor();
  await page.locator('#pvChart svg').waitFor();
  await page.locator('[data-pvcard]').filter({ hasText: 'Charizard ex' }).click();
  await page.locator('#dTitle', { hasText: 'Charizard ex' }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Back to binders' }).click();
  await page.locator('#sheet').waitFor();

  // Full backup downloads with the card and photo in it.
  await page.getByRole('button', { name: 'Settings' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download full backup' }).click()]);
  const text = await (await import('node:fs')).promises.readFile(await dl.path(), 'utf8');
  const backup = JSON.parse(text);
  if (Object.keys(backup.cards).length !== 1 || Object.keys(backup.assets).length !== 1) fail('backup contents');
  await page.keyboard.press('Escape');

  // A display case: no pages or pockets. Move the card in from its details, find it there, and
  // move it back to the binder with Move.
  await page.locator('#btnNewBinder').click();
  await page.locator('input[name=bkind][value=case]').check();
  await page.locator('#b_name').fill('Show case');
  await page.getByRole('button', { name: 'Create display case' }).click();
  await page.getByText('Show case created').waitFor();
  await page.locator('[data-caseadd]').waitFor();
  await page.getByRole('tab', { name: /Trade binder/ }).click();
  await page.locator('[data-card]').filter({ hasText: 'Charizard ex' }).click();
  await page.locator('#m_binder').selectOption({ label: 'Show case' });
  await page.locator('#btnMove').click();
  await page.getByText('Moved to Show case').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('.casegrid [data-card]').filter({ hasText: 'Charizard ex' }).waitFor();
  await page.keyboard.press('/');
  await page.locator('#findQ').fill('charizard');
  await page.getByRole('button', { name: 'Show in case', exact: true }).click();
  await page.locator('.casegrid .pocket.found').filter({ hasText: 'Charizard ex' }).waitFor();
  const inCase = page.locator('.casegrid [data-card]').filter({ hasText: 'Charizard ex' });
  const at = await inCase.boundingBox();
  await page.mouse.move(at.x + 20, at.y + 20);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  await page.locator('#pickMove').click();
  await page.locator('#mv_binder').selectOption({ label: 'Trade binder · 0 cards' });
  await page.locator('#mvGo').click();
  await page.getByText(/Moved Charizard ex to Trade binder · Page 1 · Pocket 1/).waitFor();
  await page.getByRole('tab', { name: /Trade binder/ }).click();
  await page.locator('.pocket[data-card]').filter({ hasText: 'Charizard ex' }).waitFor();

  // Table: edit a card's owner and notes in the cells, filter by a header, and the other tab follows.
  await page.locator('#btnTable').click();
  const row = page.locator('#tblBody tr').filter({ has: page.locator('input[value="Charizard ex"]') });
  await row.locator('select[data-tk="owner"]').selectOption('Megan');
  await page.getByText('Saved owner of Charizard ex').waitFor();
  await row.locator('textarea[data-tk="notes"]').fill('Centering 60/40');
  await row.locator('textarea[data-tk="notes"]').press('Enter');
  await page.getByText('Saved notes of Charizard ex').waitFor();
  await page.locator('#tf_owner').click();
  await page.locator('#tfPop label', { hasText: 'Megan' }).locator('input').check();
  await page.locator('#tblCount', { hasText: '1 of' }).waitFor();
  await page.locator('#tfPop input[data-tfpnot][value="1"]').check(); // is none of
  await page.locator('#tblCount', { hasText: /^\d+ of/ }).filter({ hasNotText: /^1 of/ }).waitFor();
  await page.keyboard.press('Escape');
  await page.locator('#tblClear').click();
  // An expression filters too, and says what's wrong with one it can't read.
  await page.locator('#tblExprBtn').click();
  // It filters when applied, not while it's being typed.
  await page.locator('#tbxText').fill('owner = Megan and setcode = OBF');
  await page.locator('#tbxStatus', { hasText: 'Not applied yet' }).waitFor();
  if (await page.locator('#tblCount', { hasText: 'expression' }).count()) fail('the expression filtered before Apply');
  await page.locator('#tbxApply').click();
  await page.locator('#tblCount', { hasText: /^1 of .*expression/ }).waitFor();
  await page.locator('#tbxText').fill('owner = ');
  await page.locator('#tbxErr', { hasText: 'Put a value after =' }).waitFor();
  if (!(await page.locator('#tbxApply').isDisabled())) fail('Apply should be off for an expression with a mistake');
  await page.locator('#tblCount', { hasText: /^1 of .*expression/ }).waitFor(); // still the applied one
  await page.locator('#tbxClear').click();
  await page.locator('#tblExprBtn').click();
  await page.locator('#tblClose').click();
  await other.locator('[data-card]').filter({ hasText: 'Charizard ex' }).click();
  await other.locator('#f_owner').filter({ has: other.locator('option[value="Megan"]:checked') }).waitFor();
  if ((await other.locator('#f_notes').inputValue()) !== 'Centering 60/40') fail('notes from the table');
  await other.keyboard.press('Escape');

  // Several copies in one pocket: add a Pikachu to pocket 2, then another copy of it in the same pocket.
  await page.locator('[data-empty="2"]').click();
  await page.locator('#f_name').fill('Pikachu');
  await page.locator('#f_number').fill('58/102');
  await page.locator('#btnSave').click();
  await page.getByText('Added Pikachu').waitFor();
  await page.locator('#btnCopyHere').click();
  if (!(await page.locator('input[name=dupwhere][value=here]').isChecked())) fail('Add a copy here should choose the same pocket');
  await page.getByRole('button', { name: 'Make 1 copy' }).click();
  await page.locator('.pocket .stackn', { hasText: '×2' }).waitFor();
  await page.locator('.copies li').nth(1).waitFor();
  if ((await page.locator('.copies li').count()) !== 2) fail('the copies list should have 2 rows');
  await page.locator('.copies [data-copy]:not(.here)').click(); // tapping a copy opens it
  await page.locator('.copies .copyrow.here').waitFor();
  await page.keyboard.press('Escape');

  // Phone layout: no sideways scrolling, and press-and-hold selection has buttons.
  const phone = await browser.newContext({ viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true });
  const p = await phone.newPage();
  watch(p);
  await p.goto(BASE);
  await p.locator('[data-card]').first().waitFor();
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 1) fail(`phone layout scrolls sideways by ${overflow}px`);
  // The ×2 badge fits on the pocket, tapping it opens the copies list, and nothing scrolls sideways.
  const badge = p.locator('.pocket .stackn', { hasText: '×2' });
  await badge.waitFor();
  const stackOverlap = await p.evaluate(() => {
    const b = document.querySelector('.pocket .stackn')?.getBoundingClientRect();
    const pr = document.querySelector('.pocket .stackn')?.parentElement?.querySelector('.price')?.getBoundingClientRect();
    return b && pr ? b.right > pr.left && b.left < pr.right && b.bottom > pr.top && b.top < pr.bottom : false;
  });
  if (stackOverlap) fail('the ×2 badge overlaps the price');
  await badge.tap();
  await p.locator('.copies li').nth(1).waitFor();
  const copiesOverflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (copiesOverflow > 1) fail(`phone copies list scrolls sideways by ${copiesOverflow}px`);
  await p.keyboard.press('Escape');
  await p.locator('#btnTable').click();
  await p.locator('#tblBody select[data-tk="owner"]').first().waitFor();
  const tblOverflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (tblOverflow > 1) fail(`phone table scrolls the page sideways by ${tblOverflow}px`);
  await p.locator('#tblClose').click();
  await p.getByRole('button', { name: 'Pricing' }).click();
  await p.locator('#pvChart svg').waitFor();
  const pvOverflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (pvOverflow > 1) fail(`phone Pricing view scrolls sideways by ${pvOverflow}px`);

  // Selling: sell the card again, then see it by occasion and as a card, on a computer and a phone.
  await page.locator('[data-card]').filter({ hasText: 'Charizard ex' }).click();
  await page.locator('#btnQuickSell').click();
  await page.locator('[data-qsamt]').fill('30');
  await page.locator('#qs_go').click();
  await page.getByText(/Sold Charizard ex for \$30\.00/).waitFor();
  await page.getByRole('button', { name: 'Selling' }).click();
  await page.locator('[data-svrange="30d"]').click();
  await page.locator('.pv-stats').getByText('$30.00').first().waitFor();
  await page.locator('#svChart svg').waitFor();
  await page.locator('[data-svgroup="occasion"]').click();
  await page.locator('[data-svkey]').filter({ hasText: 'Card show' }).click();
  await page.locator('#svFilt', { hasText: 'Filters · 1' }).waitFor();
  await page.locator('[data-svcard]').filter({ hasText: 'Charizard ex' }).click();
  await page.locator('#dTitle', { hasText: 'Charizard ex' }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Back to binders' }).click();
  await p.getByRole('button', { name: 'Selling' }).click();
  await p.locator('#svChart svg').waitFor();
  const svOverflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (svOverflow > 1) fail(`phone Selling view scrolls sideways by ${svOverflow}px`);

  // Guests: list a card for sale, turn guest viewing on, and look at it from the QR code's link on a phone.
  const showBinder = { name: 'Show binder', pockets: 9 };
  const made = await page.request.put(new URL('api/docs/binders/e2e-guest', BASE).href, { data: showBinder });
  if (!made.ok()) fail(`making a binder: ${made.status()}`);
  const listed = await page.request.put(new URL('api/docs/cards/e2e-listed', BASE).href, { data: { binderId: 'e2e-guest', page: 1, slot: 5, name: 'Pikachu', set: 'Base Set', number: '58/102', status: 'listed', condition: 'Near Mint', prices: [{ type: 'market', amount: 4.2, currency: 'CAD', date: '2026-10-01' }] } });
  if (!listed.ok()) fail(`listing a card: ${listed.status()}`);
  await page.goto(new URL('admin.html#guests', BASE).href);
  await page.getByRole('button', { name: 'Turn guest viewing on' }).click();
  await page.getByText('Guest viewing is on').first().waitFor();
  const guestUrl = await page.locator('#guestUrl').textContent();
  const g = await (await browser.newContext({ viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true })).newPage();
  watch(g);
  await g.goto(guestUrl);
  await g.locator('#gName').fill('Ash Ketchum');
  await g.locator('#gContact').fill('604-555-0199');
  await g.getByRole('button', { name: 'See the cards' }).click();
  await g.locator('.gcard').filter({ hasText: 'Pikachu' }).filter({ hasText: '$5' }).waitFor();
  if ((await g.locator('.gcard').count()) !== 1) fail('guest sees cards that are not listed for sale');
  await g.locator('#gQuery').fill('58/102');
  await g.locator('.gcard').filter({ hasText: 'Pikachu' }).click();
  await g.locator('#lbCap').getByText('Pikachu').waitFor();
  await g.locator('#lbCap').getByText('Show binder · Page 1 · Pocket 5').waitFor();
  await g.getByRole('button', { name: 'Close full screen' }).click();
  // Filters: narrow by price (nothing matches), clear from the empty state, then by set.
  await g.locator('#gQuery').fill('');
  await g.locator('#gFiltBtn').click();
  await g.locator('#gfPMin').fill('10');
  await g.getByText('No cards match these filters.').waitFor();
  await g.locator('#gFiltBtn').filter({ hasText: 'Filters · 1' }).waitFor();
  const gFiltOverflow = await g.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (gFiltOverflow > 1) fail(`phone guest page with filters open scrolls sideways by ${gFiltOverflow}px`);
  await g.locator('.empty-state [data-gclear]').click();
  await g.locator('.gcard').filter({ hasText: 'Pikachu' }).waitFor();
  await g.locator('#gfSet').selectOption({ label: 'Base Set (1)' });
  if ((await g.locator('.gcard').count()) !== 1) fail('filtering by set hides the card for sale');
  await g.locator('#gFilters [data-gclear]').click();
  await g.locator('#gFiltBtn').filter({ hasText: /^Filters$/ }).waitFor();
  await g.locator('#gFiltBtn').click();
  // The Binders view: the card in its pocket, and nothing else.
  await g.locator('[data-gview="binders"]').click();
  const pocket = g.locator('#gBinderView .pocket[data-gi]');
  await pocket.first().waitFor();
  if ((await pocket.count()) !== 1) fail('the binder view shows more than the cards for sale');
  if ((await pocket.locator('.slotno').textContent()) !== '5') fail('the binder view puts the card in the wrong pocket');
  await pocket.click();
  await g.locator('#lbCap').getByText('Pikachu').waitFor();
  await g.getByRole('button', { name: 'Close full screen' }).click();
  const gOverflow = await g.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (gOverflow > 1) fail(`phone guest page scrolls sideways by ${gOverflow}px`);
  // Hide from guests: the binder leaves the Binders view and the card loses its place, still listed.
  const hid = await page.request.put(new URL('api/docs/binders/e2e-guest', BASE).href, { data: { ...showBinder, hiddenFromGuests: true } });
  if (!hid.ok()) fail(`hiding a binder: ${hid.status()}`);
  await g.getByText('None of the cards for sale are in a binder right now.').waitFor();
  await g.locator('[data-gview="all"]').click();
  await g.locator('.gcard').filter({ hasText: 'Pikachu' }).click();
  await g.locator('#lbCap').getByText('Pikachu').waitFor();
  if ((await g.locator('#lbCap .loc').count()) !== 0) fail('a hidden binder still shows where the card is');
  await g.getByRole('button', { name: 'Close full screen' }).click();
  if ((await g.request.get(new URL('api/guest/cards', BASE).href)).status() !== 200) fail('guest card list');

  if (errors.length) fail(`page errors:\n${errors.join('\n')}`);
  console.log('Binder smoke test passed');
} finally {
  await browser.close();
}
