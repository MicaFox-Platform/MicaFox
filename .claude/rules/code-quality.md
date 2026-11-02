---
paths:
  - "**/*.ts"
---

# Code quality

ProbeX is read by the developers who embed it: the code is part of the product. Every change leaves the code at least
as clear and as fast as it found it. Limits marked (ESLint) are enforced by `packages/configs/eslint`.

## Structure

A reader finds a file from the folder names alone. The tree of a component is designed in its architecture doc
(`## Layout`), not grown file by file.

- Folders by component, never by layer: no `types/`, `services/`, `utils/` or `helpers/`. (Node BP 1.1)
- One concept per module. A component is a folder whose `index.ts` is its only entry; other modules import the
  folder, not its files. (Node BP 1.3, 3.9)
- A folder holds at most 8 source files, `index.ts` included; its tests live in its `__tests__/` and do not count
  (`pnpm lint`). Before it outgrows that, group its files by sub-concept into sub-component folders, each with its
  own `index.ts` (`connector/session/`, `connector/outbound/`). A root file imports a sub-component as `./session/index.js`; a sub-component imports a
  sibling as `../outbound/index.js`, never its files, and never the files of its parent (ESLint).
- Folders and files are kebab-case and named after the concept they hold (`outbound/`, `token-bucket.ts`), not after
  a ticket, a flow step or a test kind. The one exception is `__tests__/`: [testing](testing.md#where-tests-live).
- No empty folders and no leftovers: a move or split that is given up is undone completely (`pnpm lint`).
- No `utils.ts`, `helpers.ts` or `common.ts`: name a module after what it does (`backoff.ts`, `redact.ts`).
- Split by responsibility, not by size. A file over 300 lines or a function over 50 lines is split (ESLint), and each
  part gets a name that says what it does.
- Keep decisions apart from I/O: pure functions compute what to send, capture or retry; a thin shell talks to the
  socket, the inspector and timers. The pure part is tested without mocks.
- Dependencies inside a package flow one way; no import cycles (ESLint).
- No speculative code: no unused options, extension points or generic layers "for later". Three similar lines beat
  a premature abstraction.

## Classes and functions

- Functions by default. A class only for a thing with state and a lifecycle (`start`/`stop`, `connect`/`close`).
- No static-only classes and no inheritance chains: compose and inject. (Google § Classes)
- Dependencies (transport, clock, inspector session, logger) come in through constructor or factory parameters,
  never through imported singletons, so tests replace them at the boundary.
- A function does one thing at one level of abstraction. Return early instead of nesting: depth ≤ 3, complexity ≤ 10,
  ≤ 3 parameters, else one options object (ESLint).
- Never mutate a parameter (ESLint); return a new value or keep the state in its owner.
- A boolean parameter that switches behavior becomes two functions or a named option.

## Naming

| Kind                                        | Case             | Example                           |
| ------------------------------------------- | ---------------- | --------------------------------- |
| class, interface, type, type parameter      | `UpperCamelCase` | `BreakpointStore`, `T`            |
| variable, function, method, property        | `lowerCamelCase` | `resolveLocation`                 |
| module-level or static readonly constant    | `CONSTANT_CASE`  | `PROTOCOL_VERSION`                |
| quoted wire name (HTTP header, env var key) | as the wire says | `"Authorization"`, `PROBEX_TOKEN` |

- Acronyms are words: `instanceId`, `hubUrl`, `parseJson`. No `I` prefix, no `_` prefix or suffix except an unused
  parameter, no type in the name (`breakpointList`). (Google § Naming, ESLint)
- Descriptive over short: one letter only in a scope of ≤ 10 lines; only well-known abbreviations (`id`, `url`).
- Functions are verbs (`captureSnapshot`), factories `createX`, handlers `onX`; booleans read as a yes/no question
  (`isActive`, `hasSourceMap`, `shouldRetry`).
- A number with a unit says it: `timeoutMs`, `maxBytes`.
- One name per concept across code, docs and protocol: `breakpointId` everywhere, never `bpId` in one place.

## Efficiency

The SDK runs inside someone else's production process: its cost is their latency and memory.

- Know the time and space complexity of what you write. Hot-path code (pause handler, capture, send) is O(1) or O(n)
  in its input; anything worse states its bound in a comment.
- Look up by key with `Map` or `Set`, not `find`/`includes`/`indexOf` inside a loop.
- No quadratic copies: never spread, `concat` or `JSON.stringify` a growing value inside a loop; build once.
- No `shift()` on a queue that can grow: use a head index or a ring buffer.
- Every cache, queue, buffer, map and retry has a size or time bound and a documented rule for what it drops.
- Iterate instead of recursing over depth that the app or the user controls, and bound the depth.
- Do work once: hoist invariants out of loops, serialize once, reuse compiled regular expressions. No nested
  quantifiers in a regular expression that sees untrusted input (ReDoS, Node BP 6.16).
- Built-ins over utility libraries (Node BP 7.2). A new runtime dependency needs an ADR.
- Off the hot path readability wins: optimize only what a measurement shows.

```ts
// Bad: a class without state, a scan per lookup, an unbounded map
export class BreakpointUtils {
  static seen = new Map<string, Breakpoint>();
  static changed(next: Breakpoint[], prev: Breakpoint[]) {
    return next.filter((bp) => !prev.find((p) => p.id === bp.id));
  }
}

// Good: a named module, O(n + m) with a Set, the state owned by its caller
/** Returns the breakpoints of `next` whose id is not in `previous`. */
export const findAddedBreakpoints = (next: Breakpoint[], previous: Breakpoint[]): Breakpoint[] => {
  const previousIds = new Set(previous.map((breakpoint) => breakpoint.id));
  return next.filter((breakpoint) => !previousIds.has(breakpoint.id));
};
```

Sources: [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html),
[Node.js Best Practices](https://github.com/goldbergyoni/nodebestpractices).
