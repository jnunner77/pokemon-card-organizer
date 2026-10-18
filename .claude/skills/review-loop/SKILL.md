---
name: review-loop
description: Get every pushed change reviewed by the code-reviewer agent (Haiku) against its Boards ticket, fix the feedback and re-review until it passes, and only then open the pull request and ask GitHub Copilot to review it. Use after every push to a wi/ branch, before opening a pull request, and again after any later push to a branch with an open pull request.
---

# Review loop

Nothing goes up as a pull request until a separate reviewer has passed it. The reviewer is the
`code-reviewer` agent (`.claude/agents/code-reviewer.md`), which runs on the cheapest model
(Haiku), reads the code against the ticket, and answers `VERDICT: PASS` or
`VERDICT: CHANGES REQUESTED`.

Once it passes, and only then, GitHub Copilot is asked to review the pull request as a second
reviewer.

```
push ─▶ review ─▶ PASS ─────────────▶ open the pull request ─▶ request Copilot review
          ▲   └─▶ CHANGES REQUESTED ─▶ fix, check, push ─┐
          └──────────────────────────────────────────────┘
```

## 1. Push the work

Work as `CLAUDE.md` and the `boards-tickets` skill say: ticket first, branch `wi/<id>-<short-title>`,
`npm run typecheck` and `npm test` passing, commit subjects ending `(AB#<pbi> AB#<task> …)`. Push.

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

## 5. Ask Copilot to review

Only after a `VERDICT: PASS` with no findings, never while a round has findings open. Once the pull
request exists, request a review from GitHub Copilot with the GitHub MCP tool
`mcp__github__request_copilot_review` (load it with ToolSearch if it's deferred), passing
`owner: "jnunner77"`, `repo: "pokemon-card-organizer"` and the pull request number. Note it in the
**Code review** section, e.g. `Copilot review requested after the round 2 pass.`

If the request fails (the tool isn't in the session, or Copilot code review isn't enabled on the
repository), don't hold the pull request back: tell the user what failed and carry on.

Copilot's review arrives as review comments on the pull request. Treat them like the reviewer's
findings in step 3: check each against the code; fix the real ones, then put the fix through
steps 2–3 (it's a later push, below); answer the wrong ones on their thread with the reason; give
out-of-scope ones their own Boards ticket, mention it to the user and name the AB# on the thread.

Step 3's stop rules cover Copilot too: stop and ask the user if it repeats a finding you answered
with evidence, or after five Copilot reviews on the same pull request.

## Later pushes

Every later push to the branch (review comments, CI fixes, a merge of `main`) goes through steps 2–3
again: review it before or right after pushing, and fix and re-review until it passes before you
report the pull request ready or ask for its review. Once that round passes, request Copilot's
review again (step 5), so it reads the branch as it is now; never request it for a push whose round
hasn't passed. Note the new round in the pull request's **Code review** section.
