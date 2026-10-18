# Working in this repository

Pokémon Binder Ledger: a TypeScript server on plain Node 22.18+ with a plain-JavaScript page
(`public/`). The server is moving into an onion architecture in `src/` (shared, domain,
application, infrastructure, presentation); what hasn't moved yet still runs on Express in
`server/`. See `README.md` for features and the architecture, and `deploy/README.md` for hosting.

## Tickets first

Before starting any work (a feature, a fix, docs, config, even a one-line change), create its
ticket in Boards: a **PBI** for new or changed behaviour, or a **Bug** for something broken, with its
**tasks**. Follow the `boards-tickets` skill (`.claude/skills/boards-tickets/`), which creates them
through the Boards API (`BOARDS_URL`, `BOARDS_TOKEN`), and tell the user the AB# numbers before
writing code. If the API isn't reachable, stop and ask; don't start without a ticket.

Link the work to it: `AB#<id>` in every commit subject and in the pull request, task states kept
current (In Progress when started, Done when merged), and the PBI/Bug closed only once the change is
confirmed on the live binder.

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
  description, acceptance criteria and tasks; fix its findings, push and review again until it
  passes with no findings, and only then open the pull request and ask GitHub Copilot to review it
  (only after a pass; later pushes re-request it once their round passes).
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
    (`access.ts`); routes check it before reading the request.
  - `infrastructure/`: adapters that implement the ports, and in-memory ones for tests.
    `presentation/`: `node:http` routes with hand-written parsers, and an exhaustive switch (ending
    in `assertNever`) from error codes to HTTP statuses.
  - `src/compose.ts` (wiring the layers) and `src/main.ts` (starting the server) are the only
    places that know the concrete classes.
- Every change the layered routes make (the ledger's documents, price entries, sorting a binder,
  moving cards) runs as one unit of work (`StoreUnitOfWork`), so it is checked, saved and sent to
  open pages, or not applied at all. Replacing the whole ledger (a restore) runs only through the
  `WholeLedger` port, after a before-restore copy. The Express code still writes to the store
  directly until its slices move.
- Use `.ts` extensions in imports and only erasable syntax (no `enum`, `namespace` or constructor
  parameter properties): Node runs the TypeScript directly.
- In `src/`: no non-null assertions (`!`), `any`, or casts except branding ids at trust
  boundaries and typing raw JSON in infrastructure. No new runtime dependencies there: Node's
  built-in modules only.
- Tests for `src/` are `node:test` tests in `tests/<layer>/`; the vitest suites in
  `tests/legacy/` drive the whole app over HTTP and must keep passing.
