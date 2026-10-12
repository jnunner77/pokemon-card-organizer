---
name: review-loop
description: Get every pushed change reviewed by the code-reviewer agent (Haiku) against its Boards ticket, fix the feedback and re-review until it passes, and only then open the pull request. Use after the first push of a wi/ branch, before opening a pull request, and before every later push to a branch with an open pull request.
---

# Review loop

Nothing goes up as a pull request until a separate reviewer has passed it. The reviewer is the
`code-reviewer` agent (`.claude/agents/code-reviewer.md`), which runs on the cheapest model
(Haiku), reads the code against the ticket, and answers `VERDICT: PASS` or
`VERDICT: CHANGES REQUESTED`.

```
push ─▶ review ─▶ PASS ─────────────▶ open the pull request
          ▲   └─▶ CHANGES REQUESTED ─▶ fix, check, push ─┐
          └──────────────────────────────────────────────┘
```

## 1. Push the work

Work as `CLAUDE.md` and the `boards-tickets` skill say: ticket first, branch `wi/<id>-<short-title>`,
`npm run typecheck` and `npm test` passing, commit subjects ending `(AB#<pbi> AB#<task> …)`.

- No pull request yet: push, then review (the branch isn't a pull request until step 4).
- The branch already has a pull request: don't push yet. Review the local commits first (the
  reviewer reads local `HEAD` and runs the checks in the checkout) and push only after a pass; see
  **Later pushes**.

## 2. Spawn the reviewer

Gather its context:

```bash
python3 .claude/skills/boards-tickets/boards.py brief <pbi>   # ticket, description, acceptance criteria, tasks
git fetch origin main
git diff --stat origin/main...HEAD
```

Then call the Agent tool with `subagent_type: "code-reviewer"` and `model: "haiku"` (always pass
the model too, so the review stays on the cheapest model even if the agent file is missing or
changed), `run_in_background: false` (the next step needs the verdict), and a prompt built from
this template:

```
Review branch <branch> of jnunner77/pokemon-card-organizer against origin/main.
Repository checkout: <absolute path>. Round <n>.

Ticket:
<paste the full output of boards.py brief>

What the change does: <2-5 lines: the approach, files touched, how it was tested
(typecheck, tests, browser and phone-width checks for UI)>

Commits: <git log --oneline origin/main..HEAD>
Diff summary: <git diff --stat origin/main...HEAD>

<round 2+ only>
Your previous findings and what was done about each:
1. <finding> — fixed in <sha>: <how> | not changed: <reason, with evidence from the code>

Review it following your instructions and reply in your reply format.
```

Give the reviewer everything it needs in the prompt: it starts cold, with none of this conversation.

If `code-reviewer` isn't among the available agent types (agent files load when a session starts,
so one added during the session isn't there yet), use `subagent_type: "general-purpose"` with
`model: "haiku"` and start the prompt with the body of `.claude/agents/code-reviewer.md` (everything
after its front matter), then the template above. Tell it to stay read-only.

## 3. Act on the verdict

- **`VERDICT: PASS`** (no findings): go to step 4.
- **`VERDICT: CHANGES REQUESTED`**: check each finding against the code before acting on it.
  - Real: fix it. Keep the fix to what the finding needs.
  - Wrong (the code already handles it, the line doesn't say that, the rule doesn't apply): don't
    change the code; note why, with the evidence, for the next round's prompt.
  - Outside the ticket (a separate bug or a follow-up): give it its own Boards ticket and mention it
    to the user; tell the reviewer it's tracked as AB#<id>.

  Then `npm run typecheck` and `npm test` again, commit (subject still ends with the AB# ids), push,
  and go back to step 2 with the round number increased and the list of previous findings.

Repeat until the review passes with no findings. Use a fresh reviewer each round (a new Agent call,
not a continued one), so every round reads the branch as it is now.

Stop and ask the user, with the findings and your reasoning, if:

- the reviewer still raises a finding you rebutted with evidence in the previous round;
- a fix would widen the change beyond its ticket or needs a design decision;
- five rounds have gone by without a pass.

## 4. Open the pull request

Only after a pass. Follow `boards-tickets` for the title (`… (AB#<pbi>)`) and description (starts
with `AB#<pbi>` and its tasks, ends with the session attribution). Add a **Code review** section to
the description: how many rounds it took and the last verdict, e.g.
`Reviewed by the code-reviewer agent: PASS on round 2 (round 1: 2 findings, both fixed in abc1234).`
Then link the pull request on the ticket and comment, as `boards-tickets` step 3 says.

## Later pushes

Once the branch has a pull request, every new commit (review comments, CI fixes, a merge of `main`)
is reviewed before it is pushed: commit locally, run steps 2–3 on the local `HEAD`, fix and re-review
until it passes, and only then push. Note the new round in the pull request's **Code review**
section.
