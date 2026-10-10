# Pokémon Binder Ledger

Every pocket, what's in it, and what it's worth. A self-hosted app for Pokémon cards in
binders: where each card sits, a high-resolution picture of it, and a price log that keeps
its value current on its own, in Canadian dollars.

It started as a claude.ai artifact; this is the same ledger as a small web app with its own
server, so it can update prices every day and keep your data on your own server.

## Automatic prices and pictures

Every morning (after 5:00 in your time zone, catching up if the server was off) the ledger:

1. **Matches each card** to its product on [PriceCharting](https://www.pricecharting.com)
   and on [TCGplayer](https://www.tcgplayer.com). A card is linked on its own only when exactly
   one English product has the same number, name, set and variant; otherwise its drawer lists the
   likely products for you to pick (or search for). Typos, "VSTAR"/"V Star" spellings and promos
   filed under other sets are handled. A site that had no certain match is searched again a week
   later.
2. **Logs today's market price** in CAD: the **higher** of PriceCharting's ungraded price (recent
   eBay sales) and TCGplayer's market price (recent TCGplayer sales), converted at the Bank of
   Canada's daily rate. The entry says which site it came from and keeps both prices. If one site
   has no match, no price or doesn't answer, the other's price is used. Each day adds one
   entry; the last 30 days are kept, and older automatic entries are thinned to one a week (the
   last of each week) for the Pricing view's longer ranges. Prices you log yourself (what you
   paid, sales, listings, your own market prices) are never changed.
3. **Downloads the official picture**, the largest the site has (745×1042 from PriceCharting
   for most cards), and shows it instead of your photo. Your photos are kept; each card has an
   *Official image / Your photo* switch.

Each card's drawer shows its match on each site, a 30-day price chart, and *Update now*,
*Change match* (choose the product on either site), *Don't use TCGplayer* (or PriceCharting) for
that card, and *Turn off*. **Settings** shows the last run (updated, needing a match, problems) and
*Update all prices now*.

On the first real run against a 122-card collection, 120 cards were matched, priced and
pictured automatically in under 5 minutes; the other two needed a choice (a card recorded
under the wrong set, and a promo only priced as a holo). Automatic prices were a median 7%
from the prices logged by hand a week earlier.

> **About the sources.** PriceCharting and TCGplayer are read the way their own pages read
> them (about three requests per card per day across the two sites, spaced out). Neither offers this for free
> officially and their terms restrict automated access, so use it for your own collection,
> and expect to adjust `server/pricing/sources.ts` if a site changes its pages. PriceCharting
> sells an official API if you want to switch to it.
>
> **When PriceCharting refuses the binder** (it answers 403), the update stops asking it straight
> away and prices every card from TCGplayer: cards matched on PriceCharting use their TCGplayer
> product (looked for at once if they have none), new cards are matched on TCGplayer, and pictures
> already downloaded are kept. Each update asks PriceCharting once more, and *Recent updates* under
> **Administration → Prices** says when it refused. *Use PriceCharting: No, TCGplayer only* on the
> same page stops asking it at all until you turn it back on; then PriceCharting matches take over
> again as before. Nothing tries to get round a site's block.

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

Every price update also reads the card's main product, PriceCharting's when it has one: its set and
release date, or TCGplayer's set, release date and rarity for cards PriceCharting doesn't list. The
other site's product only gives a price to compare; it never fills details or the picture. They fill the card's empty fields, after TCGdex
has filled what it knows (so Classic box cards and new promos get a set and a release date too).
When you chose the product yourself and the card is filed under a different set, the card takes
the product's set: you said that product is your card.

Choosing a product that names a variant, like *Rayquaza [Ball]* or *Lapras [Reverse Holo]*, puts
that variant (*Ball*, *Reverse Holo*) in the card's **Variant / stamp** straight away, on whichever
site you chose it. A variant you already typed that agrees with it (*Reverse holo*) stays as you
wrote it; choosing a plain product leaves the field as it is. An open card shows the new value at
once, and anything you were typing in it is kept.

## Condition and value

Automatic prices are near-mint market prices. A raw card's value is that price times its
condition's share, the upper end of the usual ranges: **Near Mint 100%, Lightly Played 85%,
Moderately Played 60%, Heavily Played 35%, Damaged 15%** (a blank condition counts as Near Mint).
It's the value everywhere: pocket prices, the List view, totals, sorting by price, quick-sell
profit and CSV export. The card drawer shows both ("Lightly Played 85% of $10.00 near mint").
Prices you log yourself are what that copy is worth and stay as entered, and a graded card's grade
sets its price, so neither is adjusted (`public/condition.js`).

## Owner

Each card's details have an **Owner**: Megan, Justin or Both (blank until you set it). It's saved
with *Save changes*, copied by *Duplicate*, and has its own *Owner* column in CSV import and export.

## Filters

*Filters* in the List view narrows the cards shown (in this binder, or *All cards*): by **owner**
(tick any of Megan, Justin, Both, Not set), **set**, **rarity**, **status**, **release year** (from / to)
and **value** in CAD (min / max). Cards with no release date or value are left out when those filters
are set. The count and total value of what's shown sit next to the button, and filters are remembered
on this device until *Clear filters*.

To change many cards at once, filter, press and hold a row, *Select all*, then use the selection's
buttons. *Owner* sets the owner of every selected card; for example, to make everything that isn't
*Both* Justin's, tick Megan and Not set, select all, and choose Justin.

## Table

*Table* (above the pages, next to *Photos*) opens every card (all binders, display cases and loose
cards) in one table, to change their details like a spreadsheet: owner, notes, name, set, set code,
number, rarity, variant, language, condition, grader, grade, illustrator, status and placeholder.

- **Locked headers:** the header row and the card's name stay in place while you scroll down or across.
- **Dropdowns** for owner, status, condition, language and graded by, and a tick box for placeholder;
  set, set code, rarity, variant and illustrator suggest the values your cards already use.
- **Saving:** a change saves when you leave the cell, with *Undo*. **Enter** saves and goes down a row
  (Shift+Enter: up), **Esc** puts the cell back, **Alt+Enter** starts a new line in notes. A card
  can't be left without a name.
- **Filters in each header:** pick a value (with how many cards have it, and *(blank)*), or type to
  match part of the name, number or notes (*(blank)* and *(not blank)* work there too). Filters
  combine, the count of cards shown is at the top, and *Clear filters* shows them all again. Click a
  header to sort by it, again to flip it. Rows stay put while you edit, until you change a filter or
  the sort.
- **Columns:** Location and Released are shown to read but not edit. Picture, value, paid and the
  PriceCharting / TCGplayer match are off unless you turn them on in *Columns*.
- **↗** next to a name opens the card's details (picture, prices, moving it).

Columns, filters and the sort are remembered on this device. View-only accounts can look and filter,
but not edit.

## Pricing

*Pricing* (next to *Find a card*) shows what your cards are worth over time, for **All cards**, one
binder, or the cards not in a binder:

- **Date range:** 1D (since yesterday: what the latest daily price update changed), 7D, 30D, 90D,
  1Y, All (from the first price), or *Custom* from / to dates.
- **Filters:** owner, set, rarity, status, release year and value, like the List view's (kept
  separately, and remembered on this device).
- **Value** at the end of the range, the **change** since its start ($ and %), and the high and
  low, with a chart of the total; point at (or tap, or use the arrow keys on) the chart to read any day.
- **What moved:** the cards with the biggest moves, or added up by *Sets*, *Binders* or *Owners*,
  sorted by the biggest move ($ or %), or by change, %, value or start value, high to low or low
  to high (cards with no start price, so no %, go last). Pick it in *Sort by*, or click the
  *Start*, *End*, *Change* or *%* heading, and again to flip it; ▼ is high to low, ▲ low to high.
  Tap a card to open it; tap a set, binder or owner to see just its cards.

Each day counts the cards you have now at that day's prices (their condition-adjusted value, as
everywhere else). A card priced only later in the range counts at its first price before then, so
the line shows prices moving rather than cards being added. Placeholders and sold or traded cards
aren't counted. Daily prices are kept for 30 days and one a week before that, so ranges longer than
a month are weekly at their start.

## Selling

*Selling* (next to *Pricing*) is the overview of everything you've sold, from **all binders** or the
cards sold from one binder:

- **Date range:** 7D, 30D, 90D, 1Y, All (the default, from your first sale), or *Custom* from / to dates.
- **Filters:** owner, set, rarity, status (sold or traded), release year and **sold for** in CAD, like
  the Pricing view's, plus **where** it sold. Kept separately and remembered on this device.
- **Totals:** what it all sold for (cards and sales: a bundle is one sale), the **profit** and margin on
  what the cards cost, the average per card and the best sale.
- **Chart:** what sold each day (ranges up to a month), week (up to six months) or month; point at
  (or tap, or use the arrow keys on) a bar to read its total, cards and profit.
- **Sales by** *Cards*, *Occasions* (where and when: the card show on the 27th, eBay on the 3rd),
  *Where*, *Sets*, *Binders* (sold from), *Owners* or *Months*, sorted by latest, highest sale, most
  profit, biggest loss, best margin or most cards. Tap a card to open it; tap an occasion, place, set,
  binder, owner or month to see just its sales.

Profit is what each card sold for against what you paid for it, or its market price when you hadn't
logged a paid price, as it was on the day you sold it (the same profit as the Sales tab). Cards with
neither are counted in what sold but not in the profit.

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

**Type to place** is the quick way through a whole binder: it shows the next pocket (Page 1 · #1
first); type part of the card's name, number or set, pick the match (Enter or a tap) and it goes in
that pocket, ready for the next one. *Skip pocket* leaves a gap, *Undo last* takes the last one
back, and cards not placed yet follow. *Save* stores it all at once.

**Quick swap:** *Swap with…* in a card's drawer (under Location), then tap another card or an
empty pocket, on any page or in any binder, and they trade places straight away, with *Undo*.
With exactly two cards selected (press and hold), *Swap* does the same. *Escape* or *Cancel* stops.

**Move to another binder:** press and hold a card (or select several), then *Move*. Pick the
binder (it starts on the one you're in); the cards go **at the end**, after its last card, or **in a pocket you choose**, where any
card in the way shifts along to the next empty pocket (only as far as it has to). The pockets they
leave stay empty, so nothing else in the old binder moves. Everything moves at once, with *Undo*.

## Display cases

A **display case** is storage with no pages or pockets, like the case you take to card shows. Make
one with *+ New binder* and choose *Display case* as its type (a binder or case can change type
while it's empty). Its tab has an outlined swatch, and it works like a binder everywhere else: List
view, filters, totals, Find (*Show in case*), quick sell, Pricing and Selling.

- **Its cards** show together as one grid, by price (high to low), name, set and number, or newest
  release (*Show by*). There are no empty pockets: *+ Add card* at the end of the grid adds one.
- **Moving cards in:** press and hold cards in a binder (or select several), then *Move* and pick the
  case; or choose it under *Location* in a card's details. Nothing else moves, and *Undo* puts them
  back in their pockets. Moving a card from the case to a binder works the same way, at the end or in
  a pocket you choose. *Swap with…* trades places with a card in a case too.
- A card's location is just the case's name. *Arrange*, *Sort* and *Import page photo* are for
  binders only. In a CSV import, a row naming a case goes in it, and its Page and Pocket are ignored.

## Sort a binder by release date or price, and back

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

**Your own layout is kept.** The first sort saves where every card was (gaps included) as the
binder's *My binder layout*, and the Sort dialog then offers it next to release date and price,
so you can go back and forth between your layout and, say, price order as often as you like.
Cards added since it was saved go after its last card; cards removed since are skipped. Sorting
again never replaces the saved layout by itself: tick *Replace My binder layout* in the dialog
when you've rearranged the binder and want to keep the new layout instead.

## Everything else

- **Binders and pages** with 4, 9, 12 or 16 pockets per page, drawn like the real thing.
  Swipe between pages on a phone. Or a [display case](#display-cases), with no pages or pockets.
- **Cards** with set, number, rarity, variant, language, condition, grading, illustrator,
  status (in binder, listed, out for grading, sold, traded) and notes.
  Tap a card to open its details; the phone's Back gesture (or the browser's Back button) closes
  them and keeps you on the binder. Back also closes the Pricing and Selling views, returning to
  the binders instead of leaving the page.
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

## Guests from a QR code

Let people at a card show (or anyone you hand the code to) look through what's for sale on their
own phone, without an account:

1. *Settings → Administration → Guests*: **Turn guest viewing on** and **Print** the QR code (or
   copy its link).
2. A guest scans it and gives their **name** and a **phone number or email**, then sees every card
   marked **Listed for sale**: its picture, name, set, number, rarity, variant, language,
   condition or grade, illustrator, release year and **market value rounded up to the dollar**.
   They can search like *Find a card* (name, set, set code or number), sort by price, name or
   set date, and tap a card to flip through them all full screen (swipe, or the arrow keys).
   Their page updates live: a card you list shows up, and one you delist or sell disappears
   (from full screen too), within a second, as does a new price.
3. Nothing else in the ledger reaches a guest: not what you paid, sales, notes, owner, where a
   card sits, its price log or any other card or picture.

Guests are signed out after **15 minutes without use** and can sign in again. Several can look
at once, but no two at the same time with the same name or the same phone number or email; giving
the same name and contact again carries on where that guest was (another device is signed out).

The Guests page shows who's looking now (with *End*), and a **guest log** of every visit: name,
phone or email, when they signed in, were last active and how the visit ended. *New QR code* makes
codes already printed or shared stop working; turning guest viewing off signs every guest out.
Guests' names and contacts stay on the server, never in backups; *Clear the log* deletes them.

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
- **Guests:** guest viewing on/off, the QR code, guests looking now and the guest log (see
  [Guests from a QR code](#guests-from-a-qr-code)).
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
  connections are capped. `SECURITY_ALLOWLIST` exempts trusted addresses. Signed-in guests have
  limits each (requests and live-update connections) instead of their address's, and guest
  sign-in a looser one per address, so a venue's shared Wi-Fi isn't blocked.
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
responses), `guests.json` (guest viewing on/off, the QR code's key and the guest log; never in
backups), `status.txt` (the Overview's checks and the cards that need a person, rewritten every
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
  `config.ts` (administrators' settings), `guests.ts` (guest sign-in, sessions, log, and what guests
  see of a card; tested in `tests/guests.test.ts`), `app.ts` (HTTP API).
- `public/`: `admin.html`/`admin.js` (Administration), `login.html`/`login.js` (sign-in),
  `guest.html`/`guest.js` (the guest page).
- `public/`: the page. `app.js` is the ledger UI; `search.js` matches cards for Find (tested in
  `tests/search.test.ts`); `portfolio.js` and `selling.js` work out the Pricing and Selling views'
  numbers; `back.js` makes Back close a card's details and the Pricing and Selling views (tested in `tests/back.test.ts`); `runtime.js` connects it to the server.
