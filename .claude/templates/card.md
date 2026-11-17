<!--
Trello card format, used by /task-design (writes) and /task (reads).
Card title: `<type>: <summary>`, ≤ 60 chars; type is feat, fix, chore, docs, refactor, test or perf.
Labels, only from the board, never new ones: every area the card touches (Debugger, Connector, Logger, CLI, MCP,
Basic Hub, Hub) and every kind that applies (Docs, CI/CD, Claude). Research and Feature planning are the user's.
The sections below are the card description. Keep every section; write "none" when empty.
-->

## Problem

Who is affected, what hurts today, why it matters now. 2–5 sentences.

## Behavior

What changes from the user's point of view, including failure cases.

## Acceptance

- [ ] Observable, testable behavior. Each line becomes at least one test.

## Out of scope

- What this card deliberately does not do.

## Technical context

- Depends on: links to cards that must be done first, or none.
- Affected packages and files (`path:line`), related ADRs and docs.
- Public API or protocol impact, risks.

## Size

S | M | L — one line why.
