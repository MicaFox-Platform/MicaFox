<!--
Architecture doc template, read by /architect.
Copy to `docs/architecture/<component>.md` or `docs/architecture/<package>/<component>.md`, replace the title and
write your draft under each section: ideas, open questions and options are fine in a draft. /architect turns the
draft into the decided design and removes this comment. Rules for the final file: `.claude/rules/docs.md`.
-->

# Component name

## Purpose

What this component is for and who uses it. 1–3 sentences.

## Boundaries

- Owns: what it is responsible for.
- Does not own: what belongs to other components (link them).
- Constraints: overhead, dependencies, safety.

## Interactions

```text
This component          Other component
      │                        │
      │─────── message ───────▶│
      │◀────── reply ──────────│
```

## Layout

The component's folder tree: one line per folder and per file that is not a test, saying what it holds. At most 10
source files per folder, grouped into sub-component folders by concept: `.claude/rules/code-quality.md#structure`.

```text
packages/<package>/src/<component>/
├── index.ts            the component's only entry
├── <component>.ts      what the entry exports
└── <sub-component>/    one concept, entered through its index.ts
```

## Key flows

### Flow name

1. Step by step, including what happens on failure.

## Decisions

None yet.
