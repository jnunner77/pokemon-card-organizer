# Working in this repository

Pokémon Binder Ledger: an Express + TypeScript server (`server/`) with a plain-JavaScript page
(`public/`). See `README.md` for features and `deploy/README.md` for hosting.

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
- Before pushing: `npm run typecheck` and `npm test` pass. For UI changes, also run the app
  (`DATA_DIR=$(mktemp -d) AUTH=off PRICE_UPDATES=off npm start`) and check it in a browser,
  including a phone-sized screen (≤ 640px).
- Browser-only logic that's worth testing lives in small plain scripts in `public/` (like
  `sales.js`, `move.js`, `filter.js`) loaded before `app.js`, with tests in `tests/` that load them
  the same way.
- Update `README.md` when a feature changes what people see.
