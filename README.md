# Pokémon Binder Ledger

Every pocket, what's in it, and what it's worth. A self-hosted app for Pokémon cards in
binders: where each card sits, a high-resolution picture of it, and a price log that keeps
its value current on its own, in Canadian dollars.

It started as a claude.ai artifact; this is the same ledger as a small web app with its own
server, so it can update prices every day and keep your data on your own server.

## Automatic prices and pictures

Every morning (after 5:00 in your time zone, catching up if the server was off) the ledger:

1. **Matches each card** to its product on [PriceCharting](https://www.pricecharting.com),
   or on [TCGplayer](https://www.tcgplayer.com) for cards PriceCharting doesn't list. A card is
   linked on its own only when exactly one English product has the same number, name, set and
   variant; otherwise its drawer lists the likely products for you to pick (or search for).
   Typos, "VSTAR"/"V Star" spellings and promos filed under other sets are handled.
2. **Logs today's market price** in CAD: PriceCharting's ungraded price (recent eBay sales)
   or TCGplayer's market price, converted at the Bank of Canada's daily rate. Each day adds one
   entry; the last 30 days are kept and older automatic entries are dropped. Prices you log
   yourself (what you paid, sales, listings, your own market prices) are never changed.
3. **Downloads the official picture**, the largest the site has (745×1042 from PriceCharting
   for most cards), and shows it instead of your photo. Your photos are kept; each card has an
   *Official image / Your photo* switch.

Each card's drawer shows its match, a 30-day price chart, and *Update now*, *Change match*
and *Turn off*. **Settings** shows the last run (updated, needing a match, problems) and
*Update all prices now*.

On the first real run against a 122-card collection, 120 cards were matched, priced and
pictured automatically in under 5 minutes; the other two needed a choice (a card recorded
under the wrong set, and a promo only priced as a holo). Automatic prices were a median 7%
from the prices logged by hand a week earlier.

> **About the sources.** PriceCharting and TCGplayer are read the way their own pages read
> them (about two requests per card per day, spaced out). Neither offers this for free
> officially and their terms restrict automated access, so use it for your own collection,
> and expect to adjust `server/pricing/sources.ts` if a site changes its pages. PriceCharting
> sells an official API if you want to switch to it.

## Everything else

- **Binders and pages** with 4, 9, 12 or 16 pockets per page, drawn like the real thing.
  Swipe between pages on a phone.
- **Cards** with set, number, rarity, variant, language, condition, grading, illustrator,
  status (in binder, listed, out for grading, sold, traded) and notes.
- **Your photos**: choose, take, browse, paste or drop one; or photograph a whole binder page
  and slice it into one photo per pocket. Flip through pictures full screen.
- **Quick sell** one or many cards (press and hold to select), with profit against what you
  paid (or the market price). A **Sales** tab totals it, and a sale can be undone.
- **CSV import and export**, with a template, per-row checks and a "rows to fix" file.
- **Full backups** with photos: *Settings → Download full backup* / *Restore from backup*.
  The server also keeps the ledger as it was at the start of each of the last 14 days.
- **Live updates** between every open tab and device. **Password sign-in.**

## Running it

```bash
npm install
npm start                       # http://localhost:4100, data in ./data, no password
BINDER_PASSWORD=... npm start   # with sign-in
```

To host it for free, see [`deploy/README.md`](deploy/README.md) (recommended: next to Boards on
the existing free Google Cloud VM, at `binder.nunner.duckdns.org`).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4100` | HTTP port |
| `DATA_DIR` | `./data` | Ledger, photos, daily copies |
| `BINDER_PASSWORD` | _(none: open)_ | The password; changing it signs everyone out |
| `TZ` | `America/Vancouver` | Calendar for the price log and the daily run |
| `PRICE_UPDATE_HOUR` | `5` | Daily update starts after this hour |
| `PRICE_UPDATES` | `on` | `off` turns automatic prices and pictures off |
| `TRUST_PROXY` | _(unset)_ | Set behind a reverse proxy (`1`) |

## Data

`DATA_DIR` holds `db.json` (binders, cards and their price logs, settings), `assets/` (your
photos and the official pictures), `backups/` (the last 14 days, and the ledger before every
restore) and `session.key` (signs sign-in cookies; never in backups).

To restore without a browser, stop the app and run `npm run import-backup -- backup.json`.

## Development

```bash
npm run dev          # restarts on changes
npm run typecheck
npm test             # server tests, including the price parsers on saved pages
DATA_DIR=$(mktemp -d) PRICE_UPDATES=off npm start &
BASE_URL=http://localhost:4100/ npm run test:e2e    # browser smoke test
```

- `server/pricing/`: `sources.ts` (PriceCharting, TCGplayer, Bank of Canada), `match.ts`
  (which product is this card), `updater.ts` (the daily run and per-card updates).
- `server/`: `store.ts` (ledger file and change feed), `assets.ts` (pictures), `backup.ts`,
  `auth.ts` (password sign-in), `app.ts` (HTTP API).
- `public/`: the page. `app.js` is the ledger UI; `runtime.js` connects it to the server.
