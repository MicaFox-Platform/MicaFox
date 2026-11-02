---
description: Implement a tracker card end to end and open a PR to staging.
argument-hint: [card link]
disable-model-invocation: true
model: sonnet
effort: high
---

Card: $ARGUMENTS

Board and lists: the Tracker section of `CLAUDE.md`. Card format: `.claude/templates/card.md`.

## 1. Pick

- A link was given: take the card if it is in **Planned**, or in **In Progress** with your own
  `Started by Claude · branch <name>` comment and that branch exists locally (resume it).
- No link: take the top card of **Planned** without the Research label. None → stop.
- Anything else (someone else's In Progress, In Review, Done, Backlog) → stop and say why. Never move or edit those.
- The card's "Depends on" lists a card that is not in **Done** → stop and name it.
- The card has the Research label → stop and suggest `/architect`; research ends in a decision, not a PR.
- The card is not in the format of `.claude/templates/card.md` (a seed) → stop and suggest `/task-design <card link>`.

## 2. Clarify

Read the card, its comments, and the related code, docs and ADRs (Explore agent). List what blocks a confident
implementation: missing acceptance criteria, unclear behavior or failure cases, conflicts with docs or ADRs.
Ask them (AskUserQuestion). Post the answers as one card comment `Clarifications` (question → answer) before coding.
An open design question → stop and suggest `/architect`.

## 3. Start

1. `git switch staging && git pull --ff-only`, then `pnpm verify`. Red → stop and report; never build on red.
2. Create `<type>/<kebab-case>` from `staging`.
3. Move the card to **In Progress** and comment `Started by Claude · branch <name>`.

## 4. Plan

Every plan that adds, moves or removes a file names where each file goes, from the `## Layout` of the component's
architecture doc. A file that has no place there, or a folder it would push past 10 source files, means the plan
first updates the Layout (`.claude/rules/code-quality.md#structure`); a new sub-component folder is part of the plan.

- **S** — ≤ 2 files, behavior is clear: go.
- **M** — several files, clear goal: a 3–6 line plan inline, then go.
- **L** — public API, protocol, new package or dependency, or ambiguity: write the plan, delegate to `critic` without
  a `model` override with the card link and the plan, and revise the plan for every blocker and major or say why
  not. Show the plan with the critic's points and wait for approval.

## 5. Implement with tests

Follow `.claude/rules/`. Every acceptance line becomes at least one test.

## 6. Blast radius

Delegate to `impact`. Write a test for every item under "Tests required" (gaps in 3+ files → delegate to
`unit-tester` with the list). Update `docs/api/` when it says so. "ADR: needed" → ask the user whether the
choice meets the bar in `.claude/rules/adr.md`; if yes, stop and suggest `/architect`.

## 7. Verify and review

`pnpm verify` must be green. Delegate to `reviewer` without a `model` override. Fix every
blocker and major, then re-run `pnpm verify`.

## 8. Hand over and ship

Hand over per the Workflow section of `CLAUDE.md`. On the user's OK:

1. Commit, `git push -u origin <branch>`.
2. `gh pr create --base staging`: title = commit subject; body = card link, what changed, how it was tested.
3. Print the PR link, move the card to **In Review** and comment the PR link. Never touch the card again.

## Rework

The user asks for changes on an open PR: switch to its branch, run steps 5–8, and on OK commit and push to the
same branch. Do not move the card.
