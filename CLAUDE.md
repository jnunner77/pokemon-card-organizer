# Working in this repository

Pokémon Binder Ledger: a TypeScript server on plain Node 22.18+ with a plain-JavaScript page
(`public/`). The server is moving into an onion architecture in `src/` (shared, domain,
application, infrastructure, presentation); what hasn't moved yet still runs on Express in
`server/`. See `README.md` for features and the architecture, and `deploy/README.md` for hosting.

## Tickets first

Before changing anything (a feature, a fix, docs, config, even a one-line change), create its
ticket in Boards: a **PBI** for new or changed behaviour, or a **Bug** for something broken, with its
**tasks**. Only the planner's read-only plan comes first, since it writes the ticket's spec (see
Who does what); the ticket exists before the implementer starts or any file is edited. Follow
the `boards-tickets` skill (`.claude/skills/boards-tickets/`), which creates them through the
Boards API (`BOARDS_URL`, `BOARDS_TOKEN`), and tell the user the AB# numbers before writing code.
If the API isn't reachable, stop and ask; don't start without a ticket.

Link the work to it: `AB#<id>` in every commit subject and in the pull request, task states kept
current (In Progress when started, Done when merged), and the PBI/Bug closed only once the change is
confirmed on the live binder.

## Who does what

Every change is split across models the same way, whatever model the session runs on: follow the
`model-roles` skill (`.claude/skills/model-roles/`). The session coordinates and passes `model` on
every Agent call; it doesn't plan or write the change itself.

- **Opus plans**: the `planner` agent (`.claude/agents/planner.md`) writes the plan and the ticket's
  spec, and answers every architecture and implementation question. Only what needs the user's own
  decision goes to the user.
- **Sonnet implements**: the `implementer` agent (`.claude/agents/implementer.md`) writes the code,
  runs the checks, commits, and fixes review findings. It sends questions to the planner, not the
  user.
- **Haiku reviews**: the `code-reviewer` agent, through the `review-loop` skill.
- If the fifth review still doesn't pass, Opus takes over the fixes for three more rounds (it fixes
  the findings of reviews 5-7). If the eighth review doesn't pass, its findings get their own
  ticket and the pull request is opened anyway.

## Workflow

- Never commit to `main`; each change goes on a branch and is merged through a pull request.
- Name branches and pull requests after what they implement: the branch is `wi/<id>-<short-title>`
  for its PBI/Bug (like `wi/120-pricing-view`), even when the session suggests another name, and the
  pull request's title says what it does in plain words and ends with `(AB#<id>)`. Details in the
  `boards-tickets` skill.
- Before pushing: `npm run typecheck` and `npm test` pass. For UI changes, also run the app
  (`DATA_DIR=$(mktemp -d) AUTH=off PRICE_UPDATES=off npm start`) and check it in a browser,
  including a phone-sized screen (≤ 640px).
- Every push is reviewed before it becomes (or updates) a pull request: follow the `review-loop`
  skill (`.claude/skills/review-loop/`). It spawns the `code-reviewer` agent
  (`.claude/agents/code-reviewer.md`, on the cheapest model, Haiku) with the diff and the ticket's
  description, acceptance criteria and tasks; the implementer fixes its findings, and the branch is
  pushed and reviewed again until it passes with no findings (or the eighth fails, as above), and
  only then is the pull request opened. Don't ask GitHub Copilot to review pull requests: the
  owner turned that off.
- Browser-only logic that's worth testing lives in small plain scripts in `public/` (like
  `sales.js`, `move.js`, `filter.js`) loaded before `app.js`, with tests in `tests/legacy/` that load them
  the same way.
- Update `README.md` when a feature changes what people see.

## Code conventions

- Server code in `src/` follows the `onion-architecture-ts` skill, as Boards does. Each layer is
  its own TypeScript project and may only import the layers inside it (`#shared/…`, `#domain/…`,
  `#application/…`); `tsc -b` fails otherwise. Fix such errors by adding a port, never by widening
  a tsconfig's `references` or `include`.
  - `domain/`: business rules in aggregates (`Card`, `Binder`, `Setting`) and domain services, no
    Node or browser APIs. Expected failures are returned as `Result` errors with a `code`, never
    thrown. Time and ids are passed in.
  - `application/`: one use case class per file with an `execute` method; ports for anything
    external. Use cases orchestrate; rules belong in the domain. Who may do what is decided here
    (`access.ts`); routes check it before reading the request. Who is calling comes from
    `IdentifyCaller` (session cookie or API token) and `IdentifyGuest` (the guest cookie), which the
    request pipeline asks.
  - `infrastructure/`: adapters that implement the ports, and in-memory ones for tests.
    `presentation/`: `node:http` routes with hand-written parsers, and an exhaustive switch (ending
    in `assertNever`) from error codes to HTTP statuses.
  - Outside sources (TCGdex, tcgcsv.com, the daily price update until its slice moves) are ports
    (`src/application/catalog/ports.ts`); an adapter that gets no answer rejects with
    `SourceUnavailable`, which the use case turns into a `Result` error. Background work (new cards
    filling themselves in) waits through the `Scheduler` port and stops on shutdown.
  - `src/compose.ts` (wiring the layers) and `src/main.ts` (starting the server) are the only
    places that know the concrete classes.
- Logging goes through the `ServerLog` port (`src/application/logging.ts`); the logger itself is
  `src/infrastructure/logging/logger.ts`, and administrators' settings are the `AdminSettingsStore`
  port (admin.json). The Express code uses the same port and adapters.
- Every change the layered routes make (the ledger's documents, price entries, sorting a binder,
  moving cards, a card's details filled in, a master set's binder and cards) runs as one unit of
  work (`StoreUnitOfWork`), so it is checked, saved and sent to open pages, or not applied at all.
  A lookup's requests to TCGdex happen between reading the card and that unit of work, never
  inside it. Replacing the whole ledger (a restore) runs only through the `WholeLedger` port, after
  a before-restore copy. The Express code still writes to the store directly until its slices move.
- Secrets (password hashes, session and API token hashes, the guest key and the guest log) live in
  their own files in the data directory (`auth.json`, `sessions.json`, `guests.json`, written 0600),
  never in `db.json`, its copies, full backups or API responses other than Administration.
  PriceCharting's API token is a file of its own in `SECRETS_DIR` (`FileSecret`, written 0600),
  outside the data that's backed up: it is never shown, logged or returned, only whether one is
  saved and when. Wrong-password counts, the first-run setup code and signed-in guests stay in memory.
- Use `.ts` extensions in imports and only erasable syntax (no `enum`, `namespace` or constructor
  parameter properties): Node runs the TypeScript directly.
- In `src/`: no non-null assertions (`!`), `any`, or casts except branding ids at trust
  boundaries and typing raw JSON in infrastructure. No new runtime dependencies there: Node's
  built-in modules only (the `qrcode` package stays in infrastructure until the request pipeline
  moves).
- Tests for `src/` are `node:test` tests in `tests/<layer>/`; the vitest suites in
  `tests/legacy/` drive the whole app over HTTP and must keep passing.
