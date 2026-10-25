---
name: model-roles
description: Split every change across models whatever model the session runs on - Opus plans and answers architecture and implementation questions (planner agent), Sonnet writes the code and fixes review feedback (implementer agent), Haiku reviews (code-reviewer agent), with Opus taking over the fixes after five failed reviews. Use for any change to this repository (code, docs, config, fixes), from the first look at the request to the pull request.
---

# Model roles

The session you're in (whatever model it runs on) coordinates; three agents do the work:

| Role | Agent | Model | Does |
| --- | --- | --- | --- |
| Plan | `planner` (`.claude/agents/planner.md`) | Opus | The plan and the ticket's spec; answers every architecture and implementation question |
| Build | `implementer` (`.claude/agents/implementer.md`) | Sonnet; Opus for review rounds 5-7 | Writes the code, runs the checks, commits; fixes review findings |
| Review | `code-reviewer` (`.claude/agents/code-reviewer.md`) | Haiku | Reviews each push against the ticket (`review-loop` skill) |

The session itself doesn't plan or write the change, even when it runs on Opus or the change is one
line: it creates and updates tickets, pushes, opens the pull request, relays between the agents and
talks to the user. Agents can't spawn agents, so every hand-off goes through the session.

```
request ─▶ planner (Opus) ─▶ ticket ─▶ implementer (Sonnet) ─▶ push ─▶ code-reviewer (Haiku)
              ▲                            │  ▲                              │
              └──────── questions ─────────┘  └── findings of rounds 1-4 ────┤
                                                  (Opus: rounds 5-7)         │
                                PASS ─▶ pull request    after 8: ticket + pull request
```

## Spawning the agents

Always pass `model` on the Agent call (`"opus"`, `"sonnet"` or `"haiku"`), so each role runs on its
model whatever the session or the agent file says. Give each agent everything it needs in its
prompt: it starts cold, with none of this conversation. Wait for each one
(`run_in_background: false`): the next step needs its reply.

If an agent type isn't among the available ones (agent files load when a session starts, so one
added during the session isn't there yet), use `subagent_type: "general-purpose"` with the same
`model`, and start the prompt with the body of its agent file (everything after the front matter).

To send a running agent more (answers, findings), continue it with `SendMessage` when it's still
reachable; otherwise spawn a new one with the plan, where the work stands and the new message.

## 1. Plan (Opus)

Spawn `planner` with `model: "opus"`. Prompt: the user's request in their words, anything they've
said about it since, and the checkout path (`/home/user/pokemon-card-organizer` or wherever it is).
It replies `PLAN` with the ticket's spec, the approach, steps, tests and what needs the user.

If **Needs the user** isn't "none", ask the user (the options and the planner's recommendation),
then send the answer back to the planner for the final plan. Don't ask the user anything the
planner can decide.

## 2. Ticket and branch

Create the ticket from the plan's spec with the `boards-tickets` skill (write the JSON to the
scratchpad, `boards.py create`), tell the user the AB# numbers, set the Development task(s)
In Progress, and cut `wi/<id>-<short-title>` from the latest `origin/main`.

## 3. Build (Sonnet)

Spawn `implementer` with `model: "sonnet"`. Prompt: checkout and branch, the output of
`boards.py brief <pbi>`, the plan in full, and the commit attribution lines from this session.

- `STATUS: QUESTIONS`: send the questions, with the plan and where the work stands, to the planner
  (step 1's agent). Its `ANSWER` goes back to the implementer. Only when the planner says
  **Needs the user** do you ask the user; then the answer goes to the planner first, and its
  decision to the implementer.
- `STATUS: DONE`: check `git status` is clean and the commits end with the AB# ids, then push
  (`git push -u origin <branch>`).
- **Outside the ticket** items get their own Boards ticket (`boards-tickets`); tell the user the
  AB#.

## 4. Review (Haiku), and who fixes it

Follow the `review-loop` skill: it spawns `code-reviewer` with `model: "haiku"` after each push.
Each review is a round: round 1 reviews the first push, and each fix is pushed and reviewed as the
next round. Sonnet's work gets five reviews; if none passes, Opus gets three more:

| Review that asks for changes | Who fixes its findings | Reviewed again in |
| --- | --- | --- |
| Rounds 1-4 | Implementer on Sonnet | Rounds 2-5 |
| Rounds 5-7 | Implementer on Opus | Rounds 6-8 |
| Round 8 | Nobody: its findings go to a ticket | — |

- **Sonnet's fixes** (findings of rounds 1-4): send them to the implementer on Sonnet
  (`model: "sonnet"`). It fixes the real ones, gives evidence for the wrong ones, and sends design
  questions or disputed findings back as `STATUS: QUESTIONS`, which go to the planner as in step 3.
  A finding the reviewer repeats after a rebuttal goes to the planner too: it decides whether the
  rebuttal stands.
- **Opus's fixes** (round 5 didn't pass, so findings of rounds 5-7): spawn a new `implementer` with
  `model: "opus"`, giving it the plan, every round's findings and what was done about each.
  Questions still go to the planner.
- **Round 8 doesn't pass**: its findings aren't fixed. Create a ticket for them with
  `boards-tickets` (a Bug for defects, a PBI otherwise; its description lists each finding with the
  reviewer's reasoning), then open the pull request anyway (`review-loop` step 4),
  naming that ticket in its **Code review** section. Tell the user the pull request and the ticket.

Push after every fix, then review again, as `review-loop` says.

## 5. Pull request and after

Open it as `review-loop` step 4 says, and link it on the ticket. Later pushes (review comments on
the pull request, CI fixes) go through the same roles: the implementer on Sonnet makes the change,
the planner answers questions, and `review-loop` reviews it. Each later change counts its own
rounds from 1, so Opus takes over after its fifth failed review and a ticket follows its eighth.
