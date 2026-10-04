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

## New cards fill themselves in

Adding a card only needs its **name and number**:

- As you type them in *Add card*, the empty **Set, Set code, Rarity and Illustrator** fields are
  filled from [TCGdex](https://tcgdex.dev), a free, open card database, and marked so you can see
  (and *Undo*) what was filled. When several cards have that name and number (a number without the
  set size, like `51` instead of `51/162`), you pick yours from pictures. What you type is never
  replaced.
- As soon as the card is saved (from the form, a CSV import or the API) the server fills whatever
  is still empty and then looks up its **price and official picture**, so the card is complete
  within seconds instead of the next morning.
- *Settings → Card details → Fill in missing details* does the same for cards already in the
  ledger (illustrators, for instance), and the daily price run fills blanks too. Cards looked up
  are asked about again after a week, in case TCGdex has added them.

On a 122-card collection, Fill in missing details added 108 illustrators; the cards not found
were from the *Trading Card Game Classic* box, a brand-new promo, and a misspelled name.
Only English cards are looked up.

## Cards to check

Each night (and once after an update) every card is checked against TCGdex. A **To check** count
in the summary bar opens the list, flagged pockets show a **!**, and the nightly report
(`status.txt`) lists them so the *attention* alert fires until they're dealt with:

- **Filed under another set**: the set it's filed under is one TCGdex knows, but the card's name
  and number belong to another (Bill 118/130 filed under Base Set is from Base Set 2). One tap
  files it under the right set, with your own label for that set when another card has one. Your
  own naming (PBS, "Scarlet & Violet Base") is never flagged, and nor is a promo filed under the
  set it came with.
- **Name may be misspelled**: not found, but a card with that number has a close name in the same
  set (Mega Eelktross EX → Mega Eelektross ex). One tap renames it, keeping how you write "EX";
  its details, price and picture then fill in.
- **Several cards match**: pick yours from pictures.
- **Not in the card database**: TCGdex doesn't have it (Classic box cards, brand-new promos).
  *Ignore* it if it's right; it comes back only if its name or number changes, and it's checked
  again weekly in case TCGdex adds it.
- **No certain price match**: open it and choose the product.

Nothing is changed by itself: what you typed only changes when you tap a fix. A card TCGdex
doesn't have, but that a price site matched (for certain, or as you chose), isn't flagged: the
price site confirms its name and number.

### Details from the price match

Every price update also reads the product the card is priced from: PriceCharting's set and release
date, or TCGplayer's set, release date and rarity. They fill the card's empty fields, after TCGdex
has filled what it knows (so Classic box cards and new promos get a set and a release date too).
When you chose the product yourself and the card is filed under a different set, the card takes
the product's set: you said that product is your card.

## Condition and value

Automatic prices are near-mint market prices. A raw card's value is that price times its
condition's share, the upper end of the usual ranges: **Near Mint 100%, Lightly Played 85%,
Moderately Played 60%, Heavily Played 35%, Damaged 15%** (a blank condition counts as Near Mint).
It's the value everywhere: pocket prices, the List view, totals, sorting by price, quick-sell
profit and CSV export. The card drawer shows both ("Lightly Played 85% of $10.00 near mint").
Prices you log yourself are what that copy is worth and stay as entered, and a graded card's grade
sets its price, so neither is adjusted (`public/condition.js`).

## Placeholders

A **placeholder** holds a pocket for a card you don't have yet: it sits in its pocket (dimmed, with a
dashed outline and a *Placeholder* label), keeps getting its daily price so you know what it costs,
but its value isn't counted in any total and it can't be quick sold. The summary bar says how many
placeholders aren't counted.

- **Card details:** the *Placeholder* switch saves straight away; tick it when adding a card too.
- **Press and hold** a card (select mode): *Placeholder* marks the selected cards, and *Owned*
  switches them back when they all are placeholders.
- **CSV:** a *Placeholder* column (yes/no) on import and export.

## Arrange a binder by hand

*Arrange* (next to *Pages* and *List*) lists every pocket of the binder in order, page by page,
empty pockets included. Drag a card by its handle (mouse or finger), or move it one place with
↑ ↓, until the list matches where the cards really are; moved cards show where they were. *Save*
puts every card in its new page and pocket at once, with *Undo*; *Reset* starts again from the
binder as it is; *Add a page* adds empty pockets at the end. Leaving with unsaved changes asks
first, and if the binder changed meanwhile (a card added in another tab), nothing moves. Tapping
one row and then another swaps them in the list.

**Quick swap:** *Swap with…* in a card's drawer (under Location), then tap another card or an
empty pocket, on any page or in any binder, and they trade places straight away, with *Undo*.
With exactly two cards selected (press and hold), *Swap* does the same. *Escape* or *Cancel* stops.

## Sort a binder by release date or price

*Sort* (next to *Rename / edit binder*) puts every card of the binder in order, from page 1,
pocket 1 with no gaps, so you can rearrange the real binder to match:

- **Release date**, oldest or newest first. Each card gets its set's release date from TCGdex
  along with its other details (shown read-only as *Released* in the card drawer, and as a sortable
  column in the List view). A promo filed under a set by name, like *Crown Zenith*, takes that
  set's date rather than the start of its promo series. The update that added release dates
  backfills them by itself a minute after the server starts; the daily run and *Fill in missing
  details* fill any still missing.
- **Price**, highest or lowest first, by each card's current value.

A preview shows the new order page by page before anything moves. Cards with no release date
or price go at the end in their current order. All the moves are saved together, and *Undo* in
the message afterwards puts every card back.

## Everything else

- **Binders and pages** with 4, 9, 12 or 16 pockets per page, drawn like the real thing.
  Swipe between pages on a phone.
- **Cards** with set, number, rarity, variant, language, condition, grading, illustrator,
  status (in binder, listed, out for grading, sold, traded) and notes.
- **Find a card** (the *Find a card* button, or press `/`): type a Pokémon name, set name, set code
  or set number, in any combination ("pikachu m22", "base set 2 118", "7/15"). Each match shows
  where it is; **Show in binder** turns to its binder and page and highlights the pocket (loose and
  sold cards are highlighted in their list), and **Full screen** opens it in the photo viewer,
  flipping through all the matches. Arrow keys and Enter (Shift+Enter for full screen) work too.
- **Your photos**: choose, take, browse, paste or drop one; or photograph a whole binder page
  and slice it into one photo per pocket. Flip through pictures full screen.
- **Quick sell** one or many cards (press and hold to select), with profit against what you
  paid (or the market price). A **Sales** tab totals it, and a sale can be undone.
  Several cards sold together for one price (3 cards for $18) are a **bundle**: choose *One price
  for all*, enter the total, and it's split across the cards by market value, evenly or by hand
  (to the cent; Sell waits until the shares add up). Each card gets its own sale price and profit,
  and the Sales tab keeps the bundle together under one row, whose *Undo* puts every card back.
- **CSV import and export**, with a template, per-row checks and a "rows to fix" file.
- **Full backups** with photos: *Settings → Download full backup* / *Restore from backup*.
  The server also keeps the ledger as it was at the start of each of the last 14 days.
- **Live updates** between every open tab and device.

## People and administration

Everyone signs in with a username and password. Roles: **administrator** (everything,
including Administration), **editor** (changes the ledger) and **viewer** (looks only).
*Settings → Administration* (administrators only) has:

- **Overview:** checks of whether the server is ready for the public internet and healthy:
  sign-in, administrators, password rules, lockouts, HTTPS and proxy set-up, rate limits,
  daily copies and an off-server backup, log files and errors, the daily price update, the
  exchange rate and disk space. Anything not passing says what to do.
- **People:** add people with a temporary password (they choose their own on first sign-in),
  change roles, set passwords, deactivate, sign out everywhere, remove. One active administrator
  always remains.
- **Sign-in:** session length (unused, and at most), shortest password, lockout threshold.
- **API tokens:** for scripts and assistants (`Authorization: Bearer binder_…`); a token acts as
  one person, read-only or read & write, never with administrator rights, and always expires.
- **Sessions:** who is signed in where; end any session.
- **Backups:** full backup download; copies on the server (daily, thinning out to weekly and
  monthly) and snapshots, each downloadable or restorable; how long copies are kept.
- **Prices:** daily schedule (on/off, hour), update now, recent runs with their problems.
- **Security:** blocked addresses (unblock), limits, recent security events.
- **Logs:** requests, sign-ins, administration, security, prices and backups, filtered by level
  and category, with a file per day to download.

## Security on the public internet

- **Sign-in:** scrypt password hashes in `auth.json` (never in backups or responses); at least
  10 characters, not the username, not a common password; after 5 wrong passwords a username is
  locked for 1 minute, then 2, 4 … up to a day. Sessions are random tokens stored as hashes, end
  after two weeks unused and 30 days at most, and end when the password changes or the person is
  deactivated. Cookies are HttpOnly, SameSite and Secure over HTTPS.
- **Rate limits** per address and per person (with tighter ones before signing in, for
  sign-in attempts and for backups, restores and price-site searches), with `Retry-After`.
  Addresses that keep going over the limits, failing sign-in or probing for API paths are
  blocked for 15 minutes, then 30, 60 … up to a day for repeat offenders. Live-update
  connections are capped. `SECURITY_ALLOWLIST` exempts trusted addresses.
- **Requests:** changes from other websites are refused; bodies are size-limited; uploads are
  checked by their bytes; slow requests are dropped (header and request timeouts).
- **Browser:** strict Content Security Policy, HSTS over HTTPS, no framing, nosniff,
  same-origin referrers; API responses never cached.
- **Price sites** are retried with exponential backoff (honouring `Retry-After`), and a site
  that fails five cards in a row is left alone for the rest of that run.
- **Backups:** a copy of the ledger every day, kept 14 days, then one a week for 8 weeks and one
  a month for 12 months; deleted pictures are kept 400 days so any copy restores completely.
- **Container:** read-only file system apart from the data volume, no Linux capabilities,
  unprivileged user, memory and process limits.

## Running it

```bash
npm install
BINDER_PASSWORD='a long password' npm start   # http://localhost:4100, sign in as "admin"
AUTH=off npm start              # no sign-in at all (only on your own computer)
```

To host it for free, see [`deploy/README.md`](deploy/README.md) (recommended: next to Boards on
the existing free Google Cloud VM, at `binder.nunner.duckdns.org`).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4100` | HTTP port |
| `DATA_DIR` | `./data` | Ledger, photos, daily copies |
| `BINDER_PASSWORD` | | Creates the first administrator, `admin`, on the very first start (otherwise a setup code is printed in the log) |
| `AUTH` | | `off`: no sign-in at all, only for your own computer |
| `SECURITY_ALLOWLIST` | | IPs or IPv4 ranges never rate limited or blocked |
| `TZ` | `America/Vancouver` | Calendar for the price log and the daily run |
| `PRICE_UPDATE_HOUR` | `5` | Daily update starts after this hour |
| `PRICE_UPDATES` | `on` | `off` turns automatic prices and pictures off |
| `CARD_LOOKUPS` | `on` | `off` turns card details lookups (TCGdex) off |
| `TRUST_PROXY` | _(unset)_ | Set behind a reverse proxy (`1`) |

## Data

`DATA_DIR` holds `db.json` (binders, cards and their price logs, settings), `assets/` (your
photos and the official pictures; deleted ones in `assets/.trash` for 400 days), `backups/`
(daily, weekly and monthly copies, snapshots, and the ledger before every restore), `logs/` (a
file per day, two weeks), `admin.json` (backup retention, price schedule), `auth.json` and
`sessions.json` (people, password hashes, API token hashes and sessions; never in backups or
responses), `status.txt` (the Overview's checks and the cards that need a person, rewritten every
five minutes for the server's nightly job) and `offsite.json` (written by that job after it copies
a backup off the server).

To restore without a browser, stop the app and run `npm run import-backup -- backup.json`.

## Development

```bash
npm run dev          # restarts on changes
npm run typecheck
npm test             # server tests, including the price parsers on saved pages
DATA_DIR=$(mktemp -d) AUTH=off PRICE_UPDATES=off npm start &
BASE_URL=http://localhost:4100/ npm run test:e2e    # browser smoke test
```

- `server/pricing/`: `sources.ts` (PriceCharting, TCGplayer, Bank of Canada), `match.ts`
  (which product is this card), `updater.ts` (the daily run and per-card updates).
- `server/details.ts` (card details from TCGdex), `server/autofill.ts` (new cards filling themselves
  in, and Fill in missing details).
- `server/`: `store.ts` (ledger file and change feed), `assets.ts` (pictures), `backup.ts`
  (full backups), `backups.ts` (copies and retention), `accounts.ts` (people, sessions, API
  tokens), `security.ts` (rate limits and blocks), `log.ts`, `checks.ts` (Overview checks),
  `config.ts` (administrators' settings), `app.ts` (HTTP API).
- `public/`: `admin.html`/`admin.js` (Administration), `login.html`/`login.js` (sign-in).
- `public/`: the page. `app.js` is the ledger UI; `search.js` matches cards for Find (tested in
  `tests/search.test.ts`); `runtime.js` connects it to the server.
