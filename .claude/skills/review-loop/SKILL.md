---
name: review-loop
description: Get every pushed change reviewed by the code-reviewer agent (Haiku) against its Boards ticket, fix the feedback and re-review until it passes, and only then open the pull request. No GitHub Copilot review. Use after every push to a wi/ branch, before opening a pull request, and again after any later push to a branch with an open pull request.
---

# Review loop

Nothing goes up as a pull request until a separate reviewer has passed it. The reviewer is the
`code-reviewer` agent (`.claude/agents/code-reviewer.md`), which runs on the cheapest model
(Haiku), reads the code against the ticket, and answers `VERDICT: PASS` or
`VERDICT: CHANGES REQUESTED`.

Once it passes, and only then, the pull request is opened. Don't ask GitHub Copilot to review it
(`mcp__github__request_copilot_review` or otherwise): the owner turned that off.

```
push ─▶ review ─▶ PASS ─────────────▶ open the pull request
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

Who acts on it is set by the `model-roles` skill: the `implementer` agent on Sonnet fixes the
findings of rounds 1-4, the `implementer` on Opus those of rounds 5-7 (reviewed in rounds 6-8), and
the `planner` (Opus) decides every question a finding raises. The session relays; it doesn't fix
findings itself.

- **`VERDICT: PASS`** (no findings): go to step 4.
- **`VERDICT: CHANGES REQUESTED`**: send the findings to the implementer for this round. It checks
  each finding against the code before acting on it:
  - Real: fix it. Keep the fix to what the finding needs.
  - Wrong (the code already handles it, the line doesn't say that, the rule doesn't apply): don't
    change the code; note why, with the evidence, for the next round's prompt.
  - Outside the ticket (a separate bug or a follow-up): the session gives it its own Boards ticket
    and mentions it to the user; tell the reviewer it's tracked as AB#<id>.
  - Needs a design decision, or disputed: the planner decides (`model-roles` step 3).

  The implementer runs `npm run typecheck` and `npm test` again and commits (subject still ends with
  the AB# ids); the session pushes and goes back to step 2 with the round number increased and the
  list of previous findings.

Repeat until the review passes with no findings. Use a fresh reviewer each round (a new Agent call,
not a continued one), so every round reads the branch as it is now.

- A finding the reviewer still raises after a rebuttal: the planner decides whether the rebuttal
  stands; if it does, say so in the next round's prompt.
- A fix that would widen the change beyond its ticket: its own ticket, as above.
- A decision only the user can make (what they want, not how to build it): ask the user, with the
  findings and the planner's recommendation.
- Round 5 doesn't pass: the Opus implementer fixes the findings of rounds 5-7.
- Round 8 doesn't pass: its findings aren't fixed. Create a ticket for them (a Bug for defects, a
  PBI otherwise, listing each finding and the reviewer's reasoning) and open the pull request
  anyway (step 4).

## 4. Open the pull request

Only after a pass, or once round 8 has failed and its findings have a ticket (step 3). Follow
`boards-tickets` for the title (`… (AB#<pbi>)`) and description (starts with `AB#<pbi>` and its
tasks, ends with the session attribution). Add a **Code review** section to
the description: how many rounds it took and the last verdict, e.g.
`Reviewed by the code-reviewer agent: PASS on round 2 (round 1: 2 findings, both fixed in abc1234).`
After round 8 without a pass, say so and name the ticket, e.g. `Reviewed by the code-reviewer
agent: not passed after 8 rounds (Opus fixed the findings of rounds 5-7); round 8's 2 findings are
AB#<id>.`
Then link the pull request on the ticket and comment, as `boards-tickets` step 3 says.

## 5. Review comments on the pull request

If someone (or a bot that's already set up on the repository) leaves review comments, treat them
like the reviewer's findings in step 3: the implementer checks each against the code and fixes the
real ones, and the fix goes through steps 2–3 (it's a later push, below); answer the wrong ones on
their thread with the reason; give out-of-scope ones their own Boards ticket, mention it to the user
and name the AB# on the thread. Don't request a Copilot review.

## Later pushes

Every later push to the branch (review comments, CI fixes, a merge of `main`) goes through steps 2–3
again, counting its own rounds from 1: review it before or right after pushing, and fix and re-
review until it passes before you report the pull request ready or ask for its review. Note the new
round in the pull request's **Code review** section.
