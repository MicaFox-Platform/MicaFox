---
description: Turn a doc in docs/architecture into the decided design, or change an existing one; record interface changes in docs/api and the reasoning in an ADR.
argument-hint: <docs/architecture/file.md> [what to discuss or change] | <card link>
disable-model-invocation: true
model: opus
effort: high
---

Input: $ARGUMENTS

You are the architect for MicaFox. This is a conversation, one step per reply. Do not write code.

The input is a path to a file in `docs/architecture/`, optionally followed by a focus:

- **Path only** — the file is a draft made from `.claude/templates/architecture.md`: the user's ideas, open
  questions and options under its sections. Goal: turn the whole file into the decided design.
- **Path + focus** — the file is decided design; the focus says what to discuss or change. Goal: change only that
  and keep the rest of the file consistent with it.

The input may also be, or include, a link to a card on the Trello board https://trello.com/b/hzrnwdVz/micafox. A
card link alone takes the path and focus from the `/architect` command in the card's description. Read the card
and its comments. Take it only if it is in **Planned**, or in **In Progress** with your own `Started by Claude`
comment; anything else → stop and say why, and never move or edit it. The card's "Depends on" lists a card that is
not in **Done** → name it and ask whether to go on, since design may run ahead of the code it depends on.

No path, a path outside `docs/architecture/` or a missing file → stop and ask for one; to start a new component,
the user copies the template first.

1. **Branch.** `git switch staging && git pull --ff-only`, then create `docs/<kebab-topic>` from it. An uncommitted
   draft comes along with the switch. With a card, move it to **In Progress** and comment
   `Started by Claude · branch <name>`.
2. **Ground it.** Read the file, `docs/vision.md`, the overviews (`docs/architecture/overview.md`,
   `docs/api/overview.md`), the docs it links or touches in `docs/architecture/` and `docs/api/`, and the ADRs whose
   titles touch the topic. Use the Explore agent for code facts.
3. **Gaps.** List what the file does not decide yet: open questions, contradictions with other docs or ADRs, missing
   failure cases, sections still empty. With a focus, list only what the focus touches.
4. **Clarify.** Ask the 2–6 questions whose answers change the design: who consumes it, scale, latency, overhead in
   the host app, compatibility, operations. Use AskUserQuestion with concrete options. Repeat until the
   requirements are clear, then restate them in a short list and get a confirmation.
5. **Real choices.** For each point where one option is clearly right, or that misses the ADR bar in
   `.claude/rules/adr.md`, say so: no ADR. For each choice that meets the bar, present 2–3 viable options: how it works (2–3 lines), what it costs (host-app overhead, protocol
   impact, complexity, operations), what it rules out later, how it fits the vision's principles. Recommend one
   with the reason. The user decides; iterate if they push back.
6. **Critique.** Delegate to `critic` without a `model` override, with the file path, the requirements from step 4
   and the choices from step 5. Show every blocker and major with your view on it; the user decides what changes,
   and a changed choice goes back to step 5.
7. **Record**, once the user confirms:
   - The input file holds only the decided design, per `.claude/rules/docs.md`: no ideas, alternatives or open
     questions left, template comment removed.
   - Other component docs updated where the design touches them, and every overview above a changed doc checked
     and updated, per the Overviews section of `.claude/rules/docs.md`.
   - An ADR for each real choice from step 5, per `.claude/rules/adr.md`.
   - `docs/api/<package>.md` or `docs/api/<package>/<part>.md` when a public interface changes (for example
     `debugger.start()` becomes `debugger.run()`), per `.claude/rules/docs.md`; a new package's file from
     `.claude/templates/api.md`.
   - What is still undecided is not written down: it becomes a follow-up.
8. **Hand over and ship** per the Workflow section of `CLAUDE.md`; the PR body links the card, if there is one. With
   a card, once the PR is created, move the card to **In Review** and comment the PR link. Then list the follow-up
   work and offer `/task-design` for it.
