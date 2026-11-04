---
paths:
  - "**/*.ts"
---

# TypeScript

From the [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html) (§ = its section), with
ProbeX deviations marked _ProbeX_. Prettier owns formatting. Design, naming and efficiency:
[code quality](code-quality.md).

## Enforced by ESLint

`packages/configs/eslint` reports these on every edit; write them right the first time. Named exports only, a
default export only in `*.config.ts`. Explicit return types on exports (_ProbeX_). No `any` or `{}` (use `unknown`
and narrow), no `enum` (_ProbeX_: string-literal unions, they travel as JSON), no `namespace`, `require`, `!`,
`@ts-ignore` or `@ts-nocheck`. `interface` for object shapes. Object literals are annotated, never asserted.
TypeScript `private`, never `#private`. Throw only `Error` objects; no floating promises; `return await` inside
`try`. `===`, with `== null` only to match both `null` and `undefined`. A `switch` on a union covers every member,
any other ends with `default`. `for...of` over arrays and `Object.entries()`, never `for...in`. No nested ternaries.

## Comments

- Comments explain WHY (constraint, trade-off, non-obvious behavior), never WHAT the next line does.
- No commented-out code, no TODO comments: open a ticket instead.
- TSDoc: one line on every export of a package's public API (`sdk`, `protocol`, the `configs` typings). `@param`
  and `@returns` only when they add information; `@deprecated` names the replacement. (§ Comments)

## Modules

- Export only what other modules use. No `export let`, no static-only container classes. (§ Exports)
- `import type` for types; `node:` prefix for built-ins (Node BP 6.27).
- Import other packages by name (`@probex-platform/protocol`), never `../../other-package/src`.
- No side effects at module load: no I/O, timers or listeners at the top level. (Node BP 3.13)

## Functions

- Arrow functions (`const name = (...): T => ...`); `function` only where required: `this` binding, generators,
  overloads. _ProbeX: Google prefers declarations; we keep one style, as Node BP 3.12 does._ ESLint rejects
  declarations but not `function` expressions.
- Default parameter values are simple and side-effect free; rest parameters, never `arguments`.
- Wrap a named function in an arrow before passing it as a callback when extra arguments could reach its optional
  parameters (`ids.map((id) => parseId(id))`). (§ Functions)

## Types

- `type` for unions and mapped types.
- Avoid `as`; when one is safe, a comment says why. (§ Type assertions)
- `undefined` for absence, not `null`, unless a protocol field defines `null`. _ProbeX: Google leaves it open._
- A type alias does not include `| undefined`: make the field optional or add it where the alias is used.
- The simplest type that works: a repeated field beats a clever mapped type. No generic that appears only in the
  return type. (§ Type system)
- `@ts-expect-error` only in type tests.

## Classes

- `readonly` on every field not reassigned after the constructor (ESLint checks only `private` ones); parameter
  properties for injected dependencies. Do not add or remove properties after construction. (§ Classes)
- No `public` keyword; no `_` prefix on members.
- Getters are pure and do real work; no pass-through accessors. `toString()` never throws.
- Prefer a module-level function over a private static method; no `this` in static methods.

## Errors

- Throw only `new` typed `Error` subclasses (`class BreakpointError extends Error`); reject promises with them too.
  Rethrow with `{ cause }`. (§ Exceptions, Node BP 2.2)
- Error messages and `cause` never carry captured values, tokens or URLs with credentials: they end up in logs
  ([ADR 0006](../../docs/adr/0006-authenticate-to-the-hub-with-a-bearer-token.md),
  [ADR 0012](../../docs/adr/0012-redact-secrets-by-name-inside-the-sdk.md)).
- Keep a `try` block to the lines that can throw. An empty `catch` holds a comment saying why.
- Listen to `'error'` on every emitter and stream you create. (Node BP 2.13)
- In `packages/sdk`, errors stop at the boundary: see [SDK](sdk.md).

```ts
// Bad
// get the user
export default function get(id: any) {
  /* ... */
}
// const old = legacy(id);

// Good
/** Resolves a breakpoint location to a script position. */
export const resolveLocation = (location: Location): ScriptPosition => {
  // V8 reports 0-based columns while users give 1-based ones
  return { line: location.line, column: location.column - 1 };
};
```
