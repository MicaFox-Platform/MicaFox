---
paths:
  - "docs/adr/**"
---

# ADRs

An ADR answers "why this and not that" for developers and companies using MicaFox. Write one only when the choice
meets the bar:

1. **Real choice** — at least two viable options.
2. **Costly to reverse** — reversing it changes something outside the component's own code:
   - the public API: exports, their signatures, options, environment variables, documented behavior;
   - the protocol: messages, fields, version, close codes, the guarantees peers rely on;
   - the packages: their boundaries or runtime dependencies;
   - what users, custom connectors or hubs have to implement.

Everything else goes straight into `docs/architecture/`, even when there were options: internal algorithms, queues,
timeouts, limits, defaults, module layout. Choices that cannot be made separately share one ADR; independent ones
get one each. A detail of an existing decision is not a new ADR. Never merge, squash or delete an accepted ADR that
is on `staging`: supersede it.

- File `docs/adr/<component>/NNNN-kebab-title.md`, in the folder of the component the choice belongs to, named like
  its architecture doc: `protocol/`, `sdk/connector/`, `sdk/debugger/`, `sdk/logger/`; `sdk/` for the SDK as a whole,
  `packages/` for package boundaries and publishing. A new component gets a new folder. The number is the next free
  one across all folders, no gaps. Copy `.claude/templates/adr.md` and keep its sections in order: Status, Context,
  Decision, Alternatives, Consequences.
- `docs/adr/overview.md` is the only file in the root: it lists every ADR under its component, newest last. Add the
  new ADR there in the same PR.
- First heading `# NNNN. Title`; the title is ≤ 60 chars and names the decision, not the topic.
- Status line: `<status> · YYYY-MM-DD`, where status is `Proposed`, `Accepted`, `Deprecated` or
  `Superseded by [NNNN](../<component>/NNNN-title.md)`.
- Context: the requirements and constraints that made the choice necessary.
- Decision: one or two sentences in active voice: "We use X for Y."
- Alternatives: every rejected option with the concrete reason it lost.
- Never rewrite an accepted ADR: write a new one and mark the old one superseded. Superseding, in the same PR:
  `git mv` the old file to `superseded_NNNN-kebab-title.md` in its folder, set its status, move its line in
  `overview.md` to Superseded, and fix every link to it.

```md
<!-- Bad: topic as title, no alternatives -->

# 0003. Transport

We talked about transports and WebSockets seem good.

<!-- Good -->

# 0003. Use WebSocket between the SDK and the hub

## Decision

We use one WebSocket per SDK instance, opened by its connector to the hub.

## Alternatives

- **HTTP polling** — breakpoint changes would reach the SDK only on the next poll; latency or load, never both low.
- **HTTP + Server-Sent Events** — two channels to keep in sync and SSE is one-way.
```
