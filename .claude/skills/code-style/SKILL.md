---
description: Change a code style rule in the shared ESLint/Prettier configs and apply it across the repo.
argument-hint: <style request>
disable-model-invocation: true
model: sonnet
---

Request: $ARGUMENTS

1. **Where rules live.** Style is enforced by `packages/configs/eslint/index.js` and `packages/configs/prettier/index.js`;
   the root configs only re-export them. `@micafox/configs` is shared with other projects, so every change applies
   there too: say so when the rule is opinionated or breaks existing code.
2. **Find the rule.** Pick the built-in ESLint, typescript-eslint, plugin rule or Prettier option that enforces the
   request. Prefer what the bundled plugins already offer; ask before adding a plugin. If no rule can enforce it,
   say so and propose a line in `.claude/rules/` instead.
3. **Change.** On a `build/<kebab-case>` branch from an up-to-date `staging`, change the config, and update any
   `.claude/rules/*.md` line or example that describes the same thing.
4. **Apply.** `pnpm verify:fix`, fix by hand what auto-fix cannot, then `pnpm verify:brief` must be green.
5. **Hand over and ship** per the Workflow section of `CLAUDE.md`. When the rule rewrites many files, ship the
   config change and the mass fix as two commits.
