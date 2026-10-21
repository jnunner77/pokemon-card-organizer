# Pokémon Binder Ledger

Every pocket, what's in it, and what it's worth. A self-hosted app for Pokémon cards in
binders: where each card sits, a high-resolution picture of it, and a price log that keeps
its value current on its own, in Canadian dollars.

It started as a claude.ai artifact; this is the same ledger as a small web app with its own
server, so it can update prices every day and keep your data on your own server.

## Automatic prices and pictures

Every morning (after 5:00 in your time zone, catching up if the server was off) the ledger:

1. **Matches each card** to its product on [PriceCharting](https://www.pricecharting.com), through
   its official API, and to the [TCGplayer](https://www.tcgplayer.com) product the
   [TCGdex](https://tcgdex.dev) card database names for it (see *New cards fill themselves in*). A
   card is linked to a PriceCharting product on its own only when exactly one English product has
   the same number, name, set and variant; otherwise its drawer lists the likely products for you to
   pick (or search for). Typos, "VSTAR"/"V Star" spellings and promos filed under other sets are
   handled, and a variant (a pattern, stamp, 1st Edition…) is matched to its own product
   (*Lapras [Master Ball]*). A *Holo* card is the product without a bracket (PriceCharting lists holo
   rares that way), never *[Reverse Holo]*, and a *Reverse Holo* card is never the holo. A ball
   pattern matches only the same ball (*Poke Ball* is PriceCharting's *[Ball]*, never *[Master
   Ball]*), and a stamp only the same stamp. A card linked to another printing's or ball's product
   before this was checked is matched again. A card
   PriceCharting had no certain match for is searched again a week later.
2. **Logs today's market price** in CAD, worked out from PriceCharting's ungraded price (recent
   eBay sales), TCGplayer's market price (recent TCGplayer sales) and Cardmarket's trend (Europe,
   in euros), converted at the Bank of Canada's daily rates. By default it's a **blend**, as apps
   like Collectr do (see [How a card's daily price is worked out](#how-a-cards-daily-price-is-worked-out)).
   A **graded card** (its *Graded by* and *Grade* set) is valued at PriceCharting's price for its
   grader and grade instead (Grade 7, 8, 9, 9.5, PSA 10, BGS 10, CGC 10, SGC 10, TAG 10, ACE 10…),
   or the nearest grade PriceCharting has; when PriceCharting has no graded price for it, it gets
   the ungraded price, and its drawer says so. When PriceCharting doesn't answer for its product, or
   is paused, a graded card's last price stays until PriceCharting answers, rather than the
   ungraded one being logged.
   TCGplayer's and Cardmarket's prices come from TCGdex's free API, refreshed daily, for the
   card's own variant: TCGdex lists each card's regular, reverse holo and holo printings, patterns
   (Poké Ball, Master Ball, Cosmos…), stamps, 1st Edition and Shadowless separately, each with its
   own TCGplayer and Cardmarket products. The card's **Variant** picks one ("Master Ball",
   "1st Edition Shadowless", "Pokemon Together Stamp"); a variant TCGdex doesn't list, or lists
   without a price, is never given another printing's price. TCGplayer's own catalog stands in
   for TCGplayer's price when TCGdex has none (see *TCGplayer's own catalog* below). The entry says
   which source it came from
   and keeps every price. If a source has no match, no price or doesn't answer, the others are
   used, and a card the card database prices is priced even before it's matched on PriceCharting.
   Cardmarket can be left out under **Administration → Prices**. Each day adds one entry; the last
   30 days are kept, and older automatic entries are thinned to one a week (the last of each
   week) for the Pricing view's longer ranges. Prices you log yourself (what you paid, sales,
   listings, your own market prices) are never changed.
3. **Downloads the official picture**, the largest available: the card's TCGplayer product's
   (717×1000; also on days TCGplayer has no price for it, and the one TCGplayer's own catalog finds
   for a card TCGdex doesn't know), else TCGdex's own (600×825), which the TCGplayer product's
   replaces once there is one. One that won't download gives way to the next, so a card isn't left
   without a picture when TCGdex has none (it has no Trainer Gallery pictures, like Lost Origin's
   Snorlax TG10). A pattern or stamped variant gets its own TCGplayer product's picture, which
   shows it. A picture a card already has from pokemontcg.io (used until October 2026) or from
   PriceCharting (before it was read through its API) is kept. The picture is shown instead of
   your photo. Your photos are kept; each card has an *Official image / Your
   photo* switch.

Each card's drawer shows its PriceCharting and TCGplayer products, a 30-day price chart, and
*Update now*, *Change match* (search PriceCharting, or take the TCGplayer product TCGdex names),
*Don't use TCGplayer* (or PriceCharting) for that card, and *Turn off*. **Settings** shows the last
run (updated, needing a match, problems), and *Update all cards* (below) starts one now, with
*Stop the update* while one is running.

When an update goes wrong, a **red banner** across the top of the binder (and of Administration →
Prices, and a failing check on the Overview) says what happened, which card it stopped at, and
shows the update's log, with *Start it again* (or *Stop the update*), *Copy log* and *Dismiss*:

- **Interrupted:** the server restarted, was updated or crashed during it. A crash's error is
  written to the log before the server stops, and a server that was killed outright is noticed
  when it starts again. Either way an update can be started again straight away. After a
  restart or an update the daily run starts again by itself; after a crash it waits to be
  started, so a run that crashes the server doesn't do it all day.
- **Stuck:** no card finished for 10 minutes (a site that never answers). It names the card and
  what it was doing (asking PriceCharting, the card databases, downloading the picture); stop it
  and start it again.
- **Failed:** the update ended with an error partway; the cards before it were priced.

The *Prices updated* figure turns red too (*Interrupted 24/40*, *Stuck 24/40*). The banner stays
until someone dismisses it, turning amber once a later update has gone through, so a problem in
the night isn't missed. The log is read from the server's daily log files, so it's there after a
restart.

On the first real run against a 122-card collection, 120 cards were matched, priced and
pictured automatically in under 5 minutes; the other two needed a choice (a card recorded
under the wrong set, and a promo only priced as a holo). Automatic prices were a median 7%
from the prices logged by hand a week earlier.

### The sources

No site's pages are read: every price comes from an API.

- **PriceCharting** needs a subscription. Paste its API token (PriceCharting's *Subscription*
  page → *API/Download*) under **Administration → Prices → PriceCharting**; the server checks it
  with PriceCharting before saving it. It's kept in a file of its own on the server, apart from
  the ledger (`SECRETS_DIR`, its own volume in Docker), and is never shown again, logged, or put in
  backups or exports. PriceCharting's API allows one call a second and blocks, then revokes, an
  account that makes more, so every call goes through a guard:
  - **one at a time, 1.25 s apart**, retries included, whether from the daily update, *Change
    match* or checking the token;
  - **too many requests (429): every call stops** for 10 minutes (or as long as PriceCharting's
    *Retry-After* asks), logged as an error, remembered across a restart;
  - **a breaker:** 5 calls failing in a row (after their retries) stop calls for 10 minutes;
  - **a daily budget** of 2000 calls (`PRICECHARTING_DAILY_LIMIT`; a 122-card binder needs about
    250): a warning at 80%, an error and no more calls until the next day (UTC) at 100%, counted
    across restarts;
  - **recent answers reused** for 10 minutes, so the same product or search isn't asked twice in a
    row (forgotten when the token is removed or PriceCharting's data purged);
  - **retries only when it's busy or unreachable** (408, 425, 5xx, no answer): twice more, with
    growing waits and its *Retry-After* (in seconds or as a date), within 90 seconds; never for an
    answer that won't change (400, 401, 403, 404).

  While PriceCharting is paused, the update prices from TCGplayer and Cardmarket and asks it again
  afterwards by itself. *Administration → Prices* shows the calls made today against the budget,
  and a red notice while it's paused and why. If it stops accepting the token,
  that update stops asking it, prices every card from TCGplayer and Cardmarket, and *Recent
  updates* says why. Without a token, prices come from TCGplayer and Cardmarket only. Guests may
  see PriceCharting's values: the owner has PriceCharting's written permission. When the subscription ends, *Purge
  PriceCharting data* on the same page removes the token and everything that came from
  PriceCharting, as its terms ask: cards' PriceCharting matches, its prices in the daily price log
  (each day PriceCharting set or was part of is worked out again from the other sources, or
  removed when there were none) and its
  pictures (the next update downloads others). Prices you logged yourself stay; copies of the
  ledger on the server keep PriceCharting's prices until they age out.
- **The price guide:** each update downloads PriceCharting's whole Pokémon price guide (the
  subscription's *API/Download* CSV, about 95,000 products) in **one call**, through the same
  guard, and prices every PriceCharting card from it, and matches new cards against it, instead of
  one call per card (a search and a product each). It's downloaded at most once a day (it takes
  PriceCharting about half a minute to send); a product it doesn't have, a card added during the
  day, and *Change match* still ask the API, and if the download fails each card is asked about on
  its own as before. Graded prices and release dates are read from it when the subscription
  includes those columns; a graded card whose product has no graded prices in the guide is asked
  about on its own, so it still gets the price for its grade when PriceCharting's API has one. Purging PriceCharting forgets it.
- **TCGplayer's own catalog** from [tcgcsv.com](https://tcgcsv.com), a free public copy of
  TCGplayer's catalog API (sets, products, prices, pictures), refreshed daily, with no key. It fills
  what TCGdex doesn't have: a card TCGdex has no TCGplayer price for (Lost Origin's
  Trainer Gallery *Snorlax TG10*), a card TCGdex doesn't know at all, its picture, and its blank
  rarity and release date. The card is found in its set (by the set's name or code, or TCGdex's
  name for it, or a set that starts or ends with it, like *Lost Origin Trainer Gallery* for a TG card
  filed under *Lost Origin*, or *Scarlet & Violet 151* for *151*) by number, name and variant: a
  Poké Ball card gets TCGplayer's *Eevee (Poke Ball Pattern)*, never the regular card's price, and
  a regular common never its reverse holo's. When it isn't certain (two products fit), it's left
  alone. That product becomes the card's TCGplayer match. Only the sets the cards need are
  downloaded, each at most once a day, a quarter second apart; after failing three times in a row
  it isn't asked again until the next update.
- **TCGdex** is a free public API with no key. When tcgcsv.com is busy and asks for more than a
  few seconds' wait, it's left for that card until the next update rather than holding it up.
- **pokemontcg.io is no longer used** (since October 2026): it failed about one request in three
  (500 and 502 answers, often asking for a minute's wait), and only added slightly larger pictures
  (733×1024 against TCGplayer's 717×1000), a few blank details and TCGplayer prices that TCGdex and
  TCGplayer's own catalog already give.
- **Pace:** an update moves to the next card after a quarter of a second; each source keeps its
  own pace on top (PriceCharting 1.25 s between calls, tcgcsv.com ¼ s), and the price guide spares
  most PriceCharting calls.
- Links saved before PriceCharting was read through its API (by page address) are moved to their
  API product at the next update; one PriceCharting no longer has is matched again.

## Update all cards

The daily update logs every card's price and looks for what cards are missing, but some things
are only tried again once a week (a card the databases didn't have). **Settings → Update all
cards** does it now, for every card, all at once or one kind:

- **Everything:** looks every card up again in the card database (TCGdex), even the ones asked
  about this week, then logs today's price and downloads its picture.
- **Prices:** logs today's price for every card, nothing else (no lookups, no pictures).
- **Pictures:** downloads a picture for each card without an official one, or with TCGdex's smaller
  one (TCGplayer's product picture replaces it). It logs no price, and doesn't count as the day's
  price update.
- **Details:** looks every card with a blank set, set code, rarity, illustrator or release date up
  again in TCGdex. What you typed is never replaced.

Each button says how many cards it covers, shows its progress while it runs (with *Stop the
update*), and Settings says how the last picture update went (*4 pictured · 1 still without a
picture*). A card still blank afterwards is one the databases can't place by itself: its name or
number is off, or several cards match (see Cards to check); its drawer has the Google searches.

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
- *Settings → Update all cards → Details* does the same for cards already in the
  ledger (illustrators, for instance), and the daily price run fills blanks too. Cards looked up
  are asked about again after a week, in case TCGdex has added them.
- What TCGdex leaves blank for a card it found (a rarity or release date) is filled at the next
  price update from TCGplayer's own catalog and the card's PriceCharting product. Older rarity
  names are put in the binder's words ("Rare Ultra" becomes Ultra Rare). Again, nothing you typed
  is replaced.

On a 122-card collection, looking every card up added 108 illustrators; the cards not found
were from the *Trading Card Game Classic* box, a brand-new promo, and a misspelled name.
Only English cards are looked up.

### Search Google for what's still missing

When the databases and price sites come up empty, the card's drawer offers a Google search for
exactly what's missing, naming the card as you have it (name, set, number, variant, a language
other than English, and the grade of a graded card), opening in a new tab:

- **No picture:** *Search Google Images* in the empty picture box (and *Find photo on Google* next to
  the photo buttons). Save the picture you find and add it with *Choose photo*, or copy it and paste it.
- **No price:** *Search Google for its price* under Current value. *Look up prices* always has
  *Google* next to TCGplayer, PriceCharting and eBay.
- **Blank details:** under Number, *Missing rarity, illustrator* (whichever of set, set code,
  rarity and illustrator are blank) with *Search Google* for them.

Each one goes away once the card has it.

## Cards to check

Each night (and once after an update) every card is checked against TCGdex. A **To check** count
in the summary bar opens the list, flagged pockets show a **!**, and the nightly report
(`status.txt`) lists them so the *attention* alert fires until they're dealt with:

- **Filed under another set**: the set it's filed under is one TCGdex knows, but the card's name
  and number belong to another (Bill 118/130 filed under Base Set is from Base Set 2). One tap
  files it under the right set, with your own label for that set when another card has one. Your
  own naming (PBS, "Scarlet & Violet Base") is never flagged, and nor is a promo filed under the
  set it came with. Until it's dealt with (filed under the right set, or *Ignore*), the card gets
  no prices or picture from that match: a card that only shares its number would be priced
  instead.
- **Name may be misspelled**: not found, but a card with that number has a close name in the same
  set (Mega Eelktross EX → Mega Eelektross ex). One tap renames it, keeping how you write "EX";
  its details, price and picture then fill in.
- **Several cards match**: pick yours from pictures.
- **Not in the card database**: TCGdex doesn't have it (Classic box cards, brand-new promos).
  *Ignore* it if it's right; it comes back only if its name or number changes, and it's checked
  again weekly in case TCGdex adds it.
- **No certain price match**: open it and choose the product.
- **Price sources disagree**: one of its prices is more than 3 times another and at least US$5
  apart (PriceCharting US$8.50, TCGplayer US$310), which usually means one of its matches is
  another printing or set. It stays flagged until its matches change, or you tap *The prices are
  right* (the blend already leaves out a source too far from PriceCharting's price).
  *Fix past daily prices…* cleans up the days already logged (below).

### How a card's daily price is worked out

*Administration → Prices → How a card's daily price is worked out* chooses the method; daily
prices use it from the next update, and *Rebuild past daily prices…* works the past ones out
again with it.

- **PriceCharting is the anchor** (eBay sold prices: what collectors pay each other); TCGplayer
  when PriceCharting has no price that day, then Cardmarket. A source further from it than the
  **tolerance** (25%) is taken to be another card's price.
- **Blended** (the default): the weighted average of the sources, **PriceCharting 40%,
  TCGplayer 40%, Cardmarket 20%**. A source left out gives its weight to PriceCharting; one with no
  price that day shares its weight among the others. PriceCharting US$100, TCGplayer US$110,
  Cardmarket US$90 → US$102; PriceCharting US$102.71, TCGplayer US$352.67 (another card's) →
  US$102.71.
- **Highest**: the highest source, unless it's more than the tolerance from PriceCharting; then
  PriceCharting's price.
- **PriceCharting first**: PriceCharting's price, else TCGplayer's, else Cardmarket's.
- A **graded card** is always PriceCharting's price for its grade.
- **PriceCharting knows every set and variant; the card databases don't.** TCGplayer's and
  Cardmarket's prices come through TCGdex, which has subsets of them. So when a card has a
  PriceCharting product, they count only when TCGdex's card is from the same set as PriceCharting's
  product (a reprint sub-set like the 30th Classic Collection counts as 30th Celebration) and, for
  a product of a variant beyond the plain printings (a stamp, a Poké Ball pattern), the card is
  priced for that variant. Otherwise PriceCharting's price stands alone, and the day's note says
  why (*TCGplayer and Cardmarket left out: the card database's card is from Paldea Evolved,
  PriceCharting's product from 30th Celebration*). The rebuild applies this to past days too.

The weights and the tolerance can be changed there too. Each daily price's note shows the working
(*blend of PriceCharting US$100.00 (40%), TCGplayer US$110.00 (40%), Cardmarket US$90.00 (20%)*,
or what was left out and why), and the card's drawer says which method is used.

**Rebuild past daily prices…** shows what would change first (how many daily prices on how many
cards, the collection's value before and after, the cards that change most), takes a copy of the
ledger (under *Backups*, to undo it by restoring), then works every automatic daily price out
again from the sources' prices it kept, at its own day's rate. Graded prices, prices you logged
yourself, and daily prices from before each source's price was kept stay as they are.

**Fixing past daily prices.** When a source was matched to the wrong card for a while (a 30th
Celebration reprint priced as its Aquapolis or Paldea Evolved original), *Fix past daily prices…*
in the card's price log (or in *Cards to check*) takes it out of the card's history: untick the
sources that were wrong, and each daily price is worked out again from the ones left (by the
price method below) at that day's rate, or removed when none is left. It shows each day's before and after first,
and *Undo* puts them back. Prices you logged yourself are never changed; a single daily price can
also be deleted with its ✕.

How a card is matched in TCGdex: by its name and number, then the set size ("149/147") and the set
it's filed under. When it's filed under a set TCGdex knows, that set's cards come first, then the
same name in its **reprint sub-sets** (30th Classic Collection, Celebrations Classic Collection,
Trainer Galleries, Galarian Gallery), whose cards keep the printed number of the card they
reprint: a 30th Celebration Lugia 149/147 is the Classic Collection's, not Aquapolis's. TCG
Pocket's digital cards are never matched. A match you chose is kept; automatic ones made before
these rules are looked up once more.

Nothing is changed by itself: what you typed only changes when you tap a fix. A card TCGdex
doesn't have, but that a price site matched (for certain, or as you chose), isn't flagged: the
price site confirms its name and number.

### Details from the price match

Every price update also reads the card's PriceCharting product, when it has one: its set (and
release date, when PriceCharting gives one). The TCGplayer product only gives a price to compare.
They fill the card's empty fields, after TCGdex has filled what it knows (so
Classic box cards and new promos get a set too).
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
Prices you log yourself are what that copy is worth and stay as entered, and a graded card is
priced for its grade (PriceCharting's price for it, see above), so neither is adjusted
(`public/condition.js`).

## Owner

Each card's details have an **Owner**: Megan, Justin, Maiya or Both (Megan and Justin's). A card you add starts as its
binder's owner, or Justin's when the binder has none or the card isn't in a binder (change it before
saving if it isn't); cards imported from CSV without an owner, and older cards, are blank until you set it.

Binders and display cases have an owner too: chosen in *New binder* or the binder's settings (tap its
tab again), and the one picked for a [master set](#master-sets) is kept on its binder. It's only the
starting owner for cards added to it (with *+ Add card*, an empty pocket, or photos of a page);
changing it doesn't change the cards already in it. It's saved with *Save changes*, copied by *Duplicate*, and has its own
*Owner* column in CSV import and export.

## Filters

*Filters* in the List view narrows the cards shown (in this binder, or *All cards*): by **owner**
(tick any of Megan, Justin, Maiya, Both, Not set), **set**, **rarity**, **status**, **placeholders**
(*Placeholders only* for the cards you still need, *No placeholders* for the rest), **release year**
(from / to) and **value** in CAD (min / max). Cards with no release date or value are left out when
those filters are set. The count and total value of what's shown sit next to the button, and filters are remembered
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
- **Filters in each header:** tick one or more values (with how many cards have it, and *(blank)*;
  long lists have a search box, *Tick all* and *Clear*), and choose **is any of** or **is none of** to
  keep or leave out the ticked ones. Or type to match part of the name, number or notes (*(blank)* and
  *(not blank)* work there too); **not** next to the box (or a leading **!**, like `!promo`) shows the
  cards that don't match. Filters combine, the count of cards shown is at the top, and *Clear filters*
  shows them all again (and turns the expression off). Rows stay put while you edit, until you change
  a filter or the sort.
- **Sorting:** click a header to sort by it, again to flip it; **Shift+click** another header to sort
  by it next, for ties (the headers show ▲1, ▼2…). *Sort* lists the levels to change the column, flip
  it (A to Z, low to high), move it up or remove it, or add *Then by*, without a keyboard too.
- **Expression:** *Expression* opens a filter you write, for anything the headers can't say, like
  `set = "30th Celebration" and not owner in (Megan, Both) and (value > 10 or grader != Raw)`:
  - comparisons: `=` and `!=` (as shown or as stored: `status = sold`, `owner = "Not set"`,
    `location = "Binder 1"`, `released = 2026`), `~` contains and `!~` doesn't (`name:pika` works
    too), `> >= < <=` on value, paid, grade, card number and release date (`released >= 2024-06`),
    `in (a, b)` and `not in (a, b)`, `is blank` and `is not blank`;
  - `and` (or just a space), `or`, `not` (or `!`) and brackets; `and` goes before `or`;
  - a word on its own (`pikachu`, or `"full art"`) searches the name, set, number, rarity, variant,
    illustrator, grade, owner and notes. Columns go by their heading or key; case and accents don't
    matter.

  Write it, then **Apply** (or press **Enter**) to filter the table with it: typing, picking a
  suggestion, adding a condition or trying an example only changes the text, so the table stays put
  while you edit. Until it's applied the editor says so, with how many cards it would match, and
  *Revert* goes back to the applied one. As you type, it suggests the columns, the comparisons that
  suit the column, and the values your cards have; tap one to put it in. A mistake is pointed out
  (what's wrong and where) and can't be applied until it's fixed. *Add* builds a condition from a
  column, comparison and value, joined *with and* or *with or* (tick *not* for the opposite).
  *Use the header filters* moves the header filters into the expression, *Clear* stops filtering
  with it, *Save as…* keeps it under a name to use again (tap it to apply it; × deletes it), and
  *How to write an expression* has examples to try. The expression and the header filters both have
  to match; untick *Filter with this expression* to set it aside.
- **Columns:** Location and Released are shown to read but not edit. Picture, value, paid and the
  PriceCharting / TCGplayer match are off unless you turn them on in *Columns*.
- **↗** next to a name opens the card's details (picture, prices, moving it).

Columns, filters, the sort, the expression and saved expressions are remembered on this device. View-only accounts can look and filter,
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

## Bulk buy

**Bulk buy** (at the top, next to *Import CSV*) records a stack of cards bought together (16 cards at
a card show) against the [placeholders](#placeholders) waiting for them:

1. **Look in** picks where the placeholders are: the binder or display case you opened it from (it
   starts there), another one, or *All binders and cases* (the cards in no binder too). Only
   placeholders there are filled.
2. Type each card's **name and number**; a new row opens as you go (**Enter** moves along). As soon as
   both are in, the row shows the placeholder it found: its picture, set, variant and pocket. Case
   and accents don't matter, `51` finds *51/162* and *051/162* (but `51/162` never *51/165*), and
   *Pikachu* finds *Pikachu ex* when no card is called just Pikachu.
3. When several placeholders fit (a regular, reverse holo and Poké Ball copy, or the same number in
   two sets), the row asks **which one** you bought. Copies of the same printing aren't asked about:
   the first free pocket is filled. Two rows for the same card fill two placeholders.
4. Enter what you paid for each card, then the **tax** for the whole purchase at the end, with the
   currency, date and (optionally) where. The tax is shared across the cards **in proportion to their
   prices**, to the cent, and each row shows its price, its share of the tax and the two together;
   the total shows the subtotal, tax (and its rate) and total.
5. A card with **no placeholder** is **flagged in red** and **not entered**: no placeholder in your
   binders, its placeholder is in another binder than the one you're looking in (the row says which),
   already owned (not a placeholder), or every placeholder for it already taken by the rows above. Its price still counts for sharing out the tax, so the other cards only get their own share.
6. *Record* switches every matched placeholder to owned and logs an **I paid** price of its price plus
   its tax share (noted *Bulk buy of 16: $10.00 + $1.19 tax*), all at once, with **Undo**. Flagged
   cards are listed afterwards: one whose placeholder is in another binder can be filled by another
   bulk buy looking there, and one with no placeholder added with *+ Add card* if you're keeping it.

Closing it with cards typed asks first. View-only accounts don't see it.

## Master sets

A **master set** is every card of one set in every variant. *+ New binder → Master set…* makes one
as a new binder of [placeholders](#placeholders), to fill as you buy the cards:

1. Pick the **set** (*151*, *Ascended Heroes*, *Base Set*; suggestions as you type, from
   [TCGdex](https://tcgdex.dev)'s English sets), its **owner** (kept on the binder, so cards you add
   to it later start as theirs) and the pockets per page; the binder is
   named *151 master set* unless you name it yourself.
2. *Find cards* lists every card in it, trainers, energy and secret rares included, with its sub-sets
   after it (Lost Origin's Trainer Gallery, Crown Zenith's Galarian Gallery, Hidden Fates' Shiny
   Vault, Celebrations' Classic Collection), in number order, once per **variant**: the regular card,
   holo, reverse holo, 1st Edition, Shadowless, and the set's reverse holo patterns (Poké Ball,
   Master Ball, the other balls, Energy symbol, Team Rocket).
3. It's **checked against TCGplayer's own catalog** (tcgcsv.com, see *The sources*), set by set and
   sub-set by sub-set (TCGplayer's *Generations: Radiant Collection* for the RC cards TCGdex keeps
   in Generations): a printing TCGplayer lists that TCGdex doesn't is added from TCGplayer, marked
   *from TCGplayer* and matched to its TCGplayer product, so it's priced and pictured as that
   printing. TCGdex leaves out the reverse holos of the whole Black & White, XY and Sun & Moon eras
   (Hidden Fates, Shining Legends and Dragon Majesty too), a few cards (Shrouded Fable's reverse holo
   Energies) and the plain copies TCGplayer lists of some holo rares (named *Non-Holo*): about 4,600
   printings across 62 sets, all added from TCGplayer (checked against all 174 sets both have, in
   October 2026). The preview says how many were added, or, in red, when TCGplayer couldn't be
   asked (try again later to check). Trainer kits can't be checked (TCGplayer sells both halves as
   one set).
4. **Promo printings** (store and event stamps like GameStop, Pokémon Center and Player Rewards,
   Cosmos holos from blisters, metal cards) are left out unless you tick them (151 is 360
   placeholders, or 382 with them). TCG Pocket's digital cards and jumbo cards are never included.
5. *Create binder* puts one placeholder per variant in the new binder, page 1 pocket 1 onwards, with
   its name, set, set code, number, rarity, variant, illustrator, release date, language and owner
   filled in, and already matched to its TCGdex card.

Master sets are of whole sets only. A Pokémon's master set (every card of it across every set) was
tried and dropped: the card databases miss too many of a Pokémon's promo and special printings
(Prize Pack and Battle Academy stamps, blister Cosmos holos, store exclusives) for it to be complete.

Placeholders get their prices and pictures by themselves straight afterwards, one card at a time
(a few hundred cards take a while; PriceCharting's daily budget may leave some for the next day).
When you buy one, open it and switch *Placeholder* off (or select several and choose *Owned*, or
record a stack of them with [Bulk buy](#bulk-buy)), and
change anything that differs (its condition, a grade). Cards you don't collect can be deleted like any
other card.

## Change a binder's pockets per page

A binder's settings (tap its tab again) choose its **pockets per page**: 4, 9, 12 or 16. Changing it
keeps every card in the same order, empty pockets included: the pockets are counted from page 1,
pocket 1 and laid out again on pages of the new size, so going from 9 to 4 puts pockets 5–8 of page
1 on page 2 and pocket 9 on page 3, and 4 back to 9 puts them back. The page you're on follows its
cards (page 8 of a 4-pocket binder becomes page 4 of 9). *My binder layout* moves the same way. A
binder whose cards were left in pockets past its page by an older version gets its order back the
next time its settings are saved (a sort fixes it too, since it moves every card). Its empty pockets
come back as they were for a 9-pocket binder; one that started at 12 or 16 pockets may need its gaps
checked.

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
  A pocket shows its card's variant under the name, so a set's 1st Edition, Shadowless and
  reverse holo copies can be told apart.
  Tap a card to open its details; the phone's Back gesture (or the browser's Back button) closes
  them and keeps you on the binder. Closing them with something you haven't saved (a detail, a
  price you're adding or editing, a move you're setting up) asks first, whether by Back, ✕,
  tapping outside, Escape or opening another card, and so does leaving the page. Back also closes
  the Pricing and Selling views, returning to the binders instead of leaving the page.
- **Find a card** (the *Find a card* button, or press `/`): type a Pokémon name, set name, set code
  or set number, in any combination ("pikachu m22", "base set 2 118", "7/15"). Each match shows
  where it is; **Show in binder** turns to its binder and page and highlights the pocket (loose and
  sold cards are highlighted in their list), and **Full screen** opens it in the photo viewer,
  flipping through all the matches. Arrow keys and Enter (Shift+Enter for full screen) work too.
- **Look up any card** (*Find a card* → **Any card**, or *Look up … in any card* under your own
  matches): any Pokémon card, yours or not, from the TCGdex card database, by its name with its set
  or number to narrow it ("charizard base set 4", "pikachu 58/102", "SWSH050"). Choose one to see
  its picture, set, number, rarity and illustrator, and what it's worth today in CAD, worked out as
  the daily update would price it (see *How a card's daily price is worked out*), for each of its
  printings (regular, reverse holo, patterns, stamps, 1st Edition…), with TCGplayer's, Cardmarket's
  and PriceCharting's prices, PriceCharting's graded prices, and links to its products. Nothing is
  added to the ledger; **Add to a binder** opens a new card filled in with it and the printing
  chosen. Each card looked at is one PriceCharting call; once the day's calls pass three quarters of
  its budget, lookups leave PriceCharting out (and say so), keeping the rest for the daily update.
  When TCGplayer's own catalog (tcgcsv.com) doesn't answer, the card says which printings have no
  TCGplayer price because of it. Turned off with `CARD_LOOKUPS=off`.
- **Your photos**: choose, take, browse, paste or drop one; or photograph a whole binder page
  and slice it into one photo per pocket. Flip through pictures full screen.
- **Duplicate** a card (in its details) or several (press and hold to select): choose how many
  copies, 1 to 50 in all (fewer of each when several are selected). Each copy goes in the next
  empty pocket after its card, with the same details, photo and market prices; what you paid,
  listings and sales stay with the original. One copy opens it; several leave the original open
  and say where they went.
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
Guests' names and contacts are never in the ledger's copies or full backup downloads; only the
server's own archives hold them (see *Data*). *Clear the log* deletes them.

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
- **Problems:** every warning and error since they were last marked as seen, repeats grouped
  ("12× PriceCharting answered 500"), with *Include ones already seen* (the last two weeks) and
  *Copy*.
- **Logs:** requests, sign-ins, administration, security, prices and backups, filtered by level
  and category, with a file per day to download.

### Nothing fails quietly

Everything the server logs as a warning or an error (requests that fail, price sites, backups,
sign-in, security, and errors in the pages themselves) shows up for administrators straight away:

- a **red banner** (amber when there are only warnings) at the top of the binder and of
  Administration, with the newest problems, *Show all*, *Copy*, *Mark as seen* and a link to the
  Logs page;
- a **count in the binder's header** (*3 errors*) until they're marked as seen;
- the **Problems** list, which keeps them across restarts (read from the daily log files).

An error in a page (a script error, a promise that failed) is shown on that page in red, with
*Reload the page*, and reported to the server, where it's logged and joins the problems (at most
30 a minute, so a page stuck in a loop can't flood the log). The page checks for new problems
every minute.

### Recovering on its own

One fault doesn't take the binder down or lose data, and what the server did about it shows in
the problems banner:

- **Background jobs** (the daily update's schedule and its stuck-run watchdog, housekeeping, the
  status file, saving sessions, closing idle guest visits, security sweeps, filling in new cards,
  live-update connections) catch and log their own errors and keep running.
- **A save that fails** (a full disk) changes nothing, in memory or on disk; the person is told
  *Couldn't save the ledger … Nothing was changed* and it's logged as an error. A daily copy that
  can't be taken doesn't stop the change itself.
- **A damaged ledger file** (`db.json` cut short by a full disk or a crash) is kept aside as
  `db.json.damaged-<time>` and the newest copy in `backups/` that reads is loaded, with an error
  saying which copy and that later changes are missing. If no copy reads either, the server
  doesn't start (rather than start empty), leaving the file where it is to be rescued.
- **Other damaged files** are kept aside the same way: `admin.json` (default settings),
  `guests.json` (guest viewing closed, new QR code), `sessions.json` (everyone signs in again).
  A damaged `auth.json` stops the server with a clear message instead of starting without its
  people (or creating `admin` again).
- **A crash** is logged with its error before the server stops; Docker starts it again
  (`restart: unless-stopped`).
- **In the page**, each part of the screen draws on its own, so one that fails is shown in red
  while the rest still work; the live connection reconnects by itself (*Reconnecting…*) and
  reloads what it missed.

## Security on the public internet

- **Sign-in:** scrypt password hashes in `auth.json` (never in responses, the ledger's copies or
  full backup downloads; only in the server's archives, readable by the owner alone); at least
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
  a month for 12 months; deleted pictures are kept at least 400 days, and for as long as any kept
  copy refers to them, so any copy restores completely.
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
| `PRICECHARTING_DAILY_LIMIT` | `2000` | Most PriceCharting API calls a day (UTC), counted across restarts |
| `PRICE_UPDATES` | `on` | `off` turns automatic prices and pictures off |
| `CARD_LOOKUPS` | `on` | `off` turns card details lookups (TCGdex) off, and *Find a card*'s Any card |
| `TRUST_PROXY` | _(unset)_ | Set behind a reverse proxy (`1`) |
| `EVENT_LOG` | _(unset)_ | `1` writes every binder, card or setting saved or deleted to the log |

## Data

`DATA_DIR` holds `db.json` (binders, cards and their price logs, settings), `assets/` (your
photos and the official pictures; deleted ones in `assets/.trash` for at least 400 days, and while
any kept copy refers to them), `backups/`
(daily, weekly and monthly copies, snapshots, and the ledger before every restore), `logs/` (a
file per day, two weeks), `admin.json` (backup retention, price schedule), `auth.json` and
`sessions.json` (people, password hashes, API token hashes and sessions; never in responses),
`guests.json` (guest viewing on/off, the QR code's key and the guest log), `status.txt` (the
Overview's checks and the cards that need a person, rewritten every five minutes for the server's
nightly job) and `offsite.json` (written by that job after it copies a backup off the server).

What each kind of backup holds:

- **The ledger's copies** (Administration → Backups: daily, weekly, monthly, snapshots) and **full
  backup downloads** hold binders, cards, settings and (downloads only) photos. They never contain
  accounts, password or token hashes, sessions, or guests' names and contacts.
- **The server's archives** (`deploy/backup.sh`, and the copies the nightly job puts in Cloud
  Storage) hold the whole data volume except secrets, so they do contain `auth.json`,
  `sessions.json` and `guests.json`: that's what lets a server be restored with its accounts. The
  archives and their folder are readable only by the owner, and the Cloud Storage bucket is
  private.

To restore without a browser, stop the app and run `npm run import-backup -- backup.json`.

## Development

```bash
npm run dev          # restarts on changes
npm run typecheck    # tsc -b: also refuses an import that breaks the layers (below)
npm test             # node:test suites for each layer, then the older vitest suites
npm run test:unit    # only the node:test suites (fast)
npm run check        # typecheck and test together
DATA_DIR=$(mktemp -d) AUTH=off PRICE_UPDATES=off npm start &
BASE_URL=http://localhost:4100/ npm run test:e2e    # browser smoke test
```

The server runs on plain Node 22.18 or later, which runs the TypeScript directly (no build step,
no loader).

### Architecture

The server is moving to an onion architecture, like Boards: the collection's rules in the
centre, everything else (the JSON file, HTTP, the price sites) plugged in from outside. Each layer
in `src/` is its own TypeScript project that may only import the layers inside it, so
`npm run typecheck` fails if a layer reaches outward, or if the inner three use Node's APIs.

- `src/shared/`: `Result` (errors as data), branded ids, `assertNever`.
- `src/domain/`: the binders, cards and settings (`Card`, `Binder` and `Setting` aggregates), the
  rules for what a document may hold (`ledger/check-document.ts`, kept loose so fields the rules
  don't know are never dropped), changing a card's price entries one by one against its list as it
  is now (`cards/price-entries.ts`, with `public/priceops.js` working out what the page changed),
  sorting a binder (`ledger/arrange.ts`) and moving cards (`ledger/place.ts`); photos (`photos/`:
  a picture's type from its bytes, ids, the trash that keeps a deleted photo while any copy of the
  ledger refers to it) and backups (`backups/`: retention, the copies' names and kinds, the full
  backup format and what makes one restorable); people and sign-in (`accounts/`: roles, usernames,
  what makes a password acceptable, lockouts that double each time, sessions, API tokens, and the
  account book that always keeps an administrator who can sign in), guests (`guests/`: names and
  contacts, visits and the guest log, and what guests see of a card) and Administration (`admin/`:
  the settings' rules and defaults, the overview checks, status.txt's lines, the log's levels,
  categories and hidden secrets, problems grouped since last seen, PriceCharting's token format and
  the page errors' 30-a-minute limit); the cards that need a person are `cards/attention.ts`. No
  Node APIs; time is passed in.
- `src/application/`: one use case per action (`ledger/`: save, merge or delete a document, change
  price entries, sort a binder, move cards, read the ledger; `photos/`: upload, delete, show;
  `backups/`: download and restore a full backup, list, snapshot, download, restore and delete kept
  copies, change retention, the hourly housekeeping; `accounts/`: sign in, change your password,
  set up the first administrator, sign out, `IdentifyCaller` (who is behind a session cookie or API
  token), and administering people, sign-in settings, sessions and API tokens; `guests/`: a guest
  signing in and out, who a guest is, the cards and pictures they see, and Administration → Guests;
  `admin/`: the overview and status.txt, the price schedule and method, PriceCharting's token,
  problems, logs and page errors), ports for the clock, the unit of work, events, the server log
  (`logging.ts`, used by every layer above the domain), the photo store, the kept copies, password
  hashing, random secrets, the account and guest files, the QR code, admin.json, the token file, the
  disk and the daily update, and who may do what (`access.ts`).
  Replacing the whole ledger (a restore) goes only through the `WholeLedger` port, which keeps a
  before-restore copy first.
- `src/infrastructure/`: `json-store/store.ts` (the ledger file, daily copies and the change feed
  to open pages), a unit of work over it (`unit-of-work.ts`: all or nothing, one at a time, and run
  again if the store changed meanwhile), its repositories, the photo files (`photos/`), the kept
  copies (`backups/`), `auth.json` and `sessions.json` with scrypt password hashing (`accounts/`),
  `guests.json`, the page's condition rules and the QR code (`guests/`), `admin.json`, PriceCharting's
  token file, status.txt, offsite.json and the disk (`admin/`), the server log with its daily files
  (`logging/logger.ts`), random secrets (`node-secrets.ts`), and in-memory versions for tests (`memory/`; wrong-password counts and the
  setup code are only ever kept in memory).
- `src/presentation/`: the ledger's, photos', backups', sign-in and people's, guests' and
  Administration's routes (`ledger/`, `photos/`, `backups/`, `accounts/`, `guests/`, `admin/`: the
  overview, prices and PriceCharting token, problems, logs and the pages' error reports) on `node:http`, with hand-written checks
  of each request and an exhaustive switch from error codes to HTTP statuses; the guest page's live
  updates (`guests/feed.ts`).
- `src/compose.ts` wires the layers together and `src/main.ts` starts the server, building the
  store and the rest it hands over: within `src/`, they are the only files that know the concrete
  classes. `scripts/import-backup.ts` restores through the same use case as the page. The Express
  code in `server/` still uses the store and the photo files directly until its slices move.

Everything else still runs on the Express code in `server/`, which hands those routes to the layered
code, and moves into the layers one slice at a time. Express still runs the request pipeline: it
asks `IdentifyCaller` and `IdentifyGuest` who is calling, decides which pages need signing in, and
applies the rate limits.

- `server/pricing/`: `pricecharting.ts` (PriceCharting's API, price guide download and graded prices), `tcgcsv.ts` (TCGplayer's own catalog), `catalog.ts`
  (TCGdex: TCGplayer and Cardmarket prices, pictures), `sources.ts` (requests,
  Bank of Canada), `match.ts` (which product is this card), `updater.ts` (the daily run, per-card
  updates and the PriceCharting purge).
- `server/details.ts` (card details from TCGdex), `server/autofill.ts` (new cards filling themselves
  in, and Update all cards → Details).
- `server/`: `security.ts` (rate limits and blocks), `app.ts` (the request pipeline and the rest of
  the HTTP API: prices, card details, any-card lookup, master sets, rebuilding past prices, the
  PriceCharting purge and Administration → Security).
- `public/`: `admin.html`/`admin.js` (Administration), `login.html`/`login.js` (sign-in),
  `guest.html`/`guest.js` (the guest page).
- `public/`: the page. `app.js` is the ledger UI; `search.js` matches cards for Find (tested in
  `tests/legacy/search.test.ts`); `portfolio.js` and `selling.js` work out the Pricing and Selling views'
  numbers; `back.js` makes Back close a card's details and the Pricing and Selling views (tested in `tests/legacy/back.test.ts`); `runtime.js` connects it to the server.

Tests: `tests/<layer>/` holds the node:test tests for `src/` (the domain without fakes, use cases
with the in-memory adapters); `tests/legacy/` holds the vitest suites from before the layers,
which drive the whole app over HTTP and move to node:test as their slices do.
