---
description: Discuss a piece of work and create one or more ready-to-implement cards in the tracker's Backlog.
argument-hint: <topic | card link>
disable-model-invocation: true
model: opus
effort: high
---

Topic: $ARGUMENTS

The topic is free text or a link to a rough card the user wrote (a seed); for a seed, read its description and
comments as the topic.

Goal: cards that `/task` or another developer can implement without coming back with questions, each small
enough to track progress card by card. This is a conversation, one step per reply. Do not implement anything.

1. **Understand.** Read the related code, docs and ADRs: directly with Grep and Read when the topic names the files,
   else through the Explore agent. Restate the topic in two sentences:
   who has which problem and what changes for them.
2. **Discuss.** Ask in rounds of at most 4 questions (AskUserQuestion, concrete options):
   - who needs it and why now;
   - expected behavior, including edge cases and what happens on failure;
   - constraints: overhead in the host app, public API or protocol compatibility, security;
   - what is explicitly out of scope.
3. **Split.** One card is one PR: it ships on its own, keeps `pnpm verify` green and is size S or M. Work that is
   size L or holds several independent deliverables is split, usually along packages or flows (for example
   protocol types → SDK connector → SDK debugger). Propose the split as a list of titles with one line each and the
   order they depend on; the user confirms or changes it. A topic that fits one card stays one card.
4. **Draft and challenge.** For each card, propose acceptance criteria and point out what is missing or untestable.
   Check that no acceptance line falls between two cards and none is in two. Repeat until the user confirms nothing
   is missing.
5. **Architecture check.** An open design question (for example "WebSocket or HTTP?") → stop and suggest
   `/architect` first. The cards then link the resulting doc or ADR.
6. **Create.** Show all cards filled from `.claude/templates/card.md`. Once the user confirms, create them in the
   **Backlog** list of the Trello board https://trello.com/b/hzrnwdVz/probex-platform, in dependency order with
   sequential positions, so each card can link the cards it depends on, with the labels from the template. Print
   every link. Never put a card anywhere but Backlog.
7. **Seed.** A seed that stays one card is rewritten in place instead of created anew and keeps its list. A seed
   split into several cards gets a comment linking them; the user archives it.
