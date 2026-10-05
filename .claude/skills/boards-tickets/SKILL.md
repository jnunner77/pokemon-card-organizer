---
name: boards-tickets
description: Create and update the Boards tickets (PBI or Bug, with tasks) for any change to this repository. Use BEFORE starting any work (code, docs, config, fixes), and again when opening a pull request, after a merge, and when a change is confirmed on the live binder.
---

# Boards tickets

Every change starts from a ticket in Boards (the team's backlog at `$BOARDS_URL`, API in
[agile-development-operations `docs/api.md`](https://github.com/jnunner77/agile-development-operations/blob/main/docs/api.md)).
No code, docs or config change begins until its PBI or Bug and its tasks exist.

`boards.py` next to this file does the API calls (it needs `BOARDS_URL` and `BOARDS_TOKEN`; never
print, log or commit the token). If either is missing, stop and ask the user to add them to the
environment; don't start the work without a ticket.

```bash
B=.claude/skills/boards-tickets/boards.py
python3 $B whoami                         # token acts as Claude; current sprint
python3 $B create /path/to/spec.json      # PBI or Bug + tasks; prints the ids
python3 $B state "In Progress" 112        # several ids allowed
python3 $B link 110 https://github.com/jnunner77/pokemon-card-organizer/pull/18 "Pull request #18"
python3 $B comment 110 "<p>Done in …</p>"
python3 $B show 110                       # the item and its tasks
```

## 1. Before any work: create the ticket

- **PBI** (`"Product Backlog Item"`) for new or changed behaviour; **Bug** for something broken.
  Several unrelated asks get one ticket each.
- Write the spec in the scratchpad, not the repo. `boards.py create` assigns the PBI/Bug to Justin
  Nunner and the tasks to Claude, puts all of them in the current sprint, priority 2.

```json
{
  "type": "Product Backlog Item",
  "title": "Binder: <what it does, in the user's words>",
  "effort": 3,
  "tags": ["pokemon-binder", "<area: sorting, pricing, filters, ...>"],
  "description": "<p>As a collector, I want …, so that ….</p>",
  "acceptanceCriteria": "<ul><li>…</li><li>Works on phones (≤ 640px).</li></ul>",
  "tasks": [
    {"title": "<the build step: UI, server, tests>", "activity": "Development"},
    {"title": "Validate on the live binder", "activity": "Testing"}
  ]
}
```

For a Bug, use `"type": "Bug"`, `reproSteps` (HTML: steps, expected, actual) instead of
`description` (Bugs have no description; `acceptanceCriteria` still works), a `severity` of
`"1 - Critical"`, `"2 - High"`, `"3 - Medium"` or `"4 - Low"`, and priority 1 if it breaks
something people use. Title prefix `Binder:` and tag `pokemon-binder` always. Effort is
story points (1, 2, 3, 5, 8). Split development into 1–3 tasks by real steps; always end with the
Testing task "Validate on the live binder".

Tell the user the ticket numbers (e.g. "AB#113 with tasks AB#114–AB#116") before starting.

## 2. While working

- Set a task to `In Progress` when you start it: `boards.py state "In Progress" <task>`.
- Name the work in commits and pull requests with `AB#<id>`: the commit message ends its subject
  with `(AB#<pbi> AB#<task> …)`.
- Name the branch after the item: `wi/<id>-<short-title>`, a few lowercase words for what it
  implements (`wi/120-pricing-view`, `wi/117-admin-checks-any-date`). Do this even when the session
  suggests another branch name (a `claude/…` one): the owner asked for it.
- Title the pull request with what it implements, in plain words, ending with `(AB#<pbi>)`
  (`Pricing view: a binder's or the whole collection's value over time (AB#120)`), and start its
  description with `AB#<pbi>` and its tasks. If a pull request was opened for you with another
  title, retitle it.
- New work found along the way (another bug, a follow-up) gets its own ticket; mention it to the
  user rather than widening the current change.

## 3. Pull request opened and merged

- When the PR is opened: `link <pbi> <PR url> "Pull request #N"` and a comment saying what was
  done and how it was tested.
- After the merge: set the Development tasks to `Done`. Boards moves items from merge webhooks,
  but check: tasks in this repository are closed by hand.
- Leave the PBI or Bug and its "Validate on the live binder" task open until the user confirms it
  works on the live binder (after the server is updated). Then set the task `Done`, the PBI/Bug
  `Done`, and comment who confirmed it.
