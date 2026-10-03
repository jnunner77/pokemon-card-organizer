// Browser smoke test. Start the app on an empty data directory first:
//   DATA_DIR=$(mktemp -d) AUTH=off PRICE_UPDATES=off npm start
//   BASE_URL=http://localhost:4100/ npm run test:e2e
// It creates a binder and cards, prices, moves and sells one, finds it with Find, checks live
// updates between two tabs, a backup download, and the phone layout.
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

  // Full backup downloads with the card and photo in it.
  await page.getByRole('button', { name: 'Settings' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download full backup' }).click()]);
  const text = await (await import('node:fs')).promises.readFile(await dl.path(), 'utf8');
  const backup = JSON.parse(text);
  if (Object.keys(backup.cards).length !== 1 || Object.keys(backup.assets).length !== 1) fail('backup contents');
  await page.keyboard.press('Escape');

  // Phone layout: no sideways scrolling, and press-and-hold selection has buttons.
  const phone = await browser.newContext({ viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true });
  const p = await phone.newPage();
  watch(p);
  await p.goto(BASE);
  await p.locator('[data-card]').first().waitFor();
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 1) fail(`phone layout scrolls sideways by ${overflow}px`);

  if (errors.length) fail(`page errors:\n${errors.join('\n')}`);
  console.log('Binder smoke test passed');
} finally {
  await browser.close();
}
