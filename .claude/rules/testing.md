---
paths:
  - "**/*.test.ts"
  - "**/*.test-d.ts"
  - "packages/*/test/**"
---

# Testing

A test exists to fail when the behavior breaks. Coverage (≥ 80%, enforced by `pnpm test:coverage` and CI) is the
floor, not the goal: a line that runs without an assertion about its result is not tested.

## What to test

- Behavior through the public surface, not private helpers or call order. (Testing BP 1.4)
- Every acceptance criterion of the card maps to at least one test.
- The failure path: SDK code proves it does not throw into or block the host app. (Node BP 2.8)
- No test exists only to raise coverage or to restate what the compiler already checks. No assertion repeats the
  arrange step (`expect(hello.type).toBe("hello")` right after writing it) or pins a value to satisfy a lint rule.
- A line no meaningful test can reach is excluded in the root `vitest.config.ts` with a comment saying why, or named
  in the PR hand-over. Never cover it with a hollow test.
- Before finishing, ask of each test: would it fail if the code under test returned a wrong value? If not, fix it.

## Where tests live

- A unit test sits next to its module: `backoff.test.ts` beside `backoff.ts`.
- A module that needs more than 3 test files becomes a folder holding the module and its tests, named by behavior:
  `hub-connector/{index.ts, hub-connector.ts, connect.test.ts, close.test.ts}`, not `hub-connector-connect.test.ts`
  beside it (`pnpm lint`).
- A test that is not about one module lives in `packages/<name>/test/`, never loose in `src/`:
  - examples of `docs/api/` and their copies: `test/docs/<doc>.test.ts` and `test/docs/<doc>-<example>.test-d.ts`;
  - checks of the lint boundaries of the package's components: `test/boundaries.test.ts`;
  - end-to-end tests: `test/e2e/` (below).

## How

- Name tests `it("does X when Y")`; one behavior per test; no logic (`if`, loops) inside a test. (Testing BP 1.1)
- Arrange, act, assert, separated by blank lines; act and assert are usually one line each. (Testing BP 1.2)
- Data lives in the test: realistic, with only the fields that affect the result; a small factory with overrides
  when it repeats. No shared mutable fixtures. (Testing BP 1.6, 1.9, 2.7)
- Mock only at boundaries: transport, time, `node:inspector`. Never mock the module under test. Fake timers, never
  real waits. (Testing BP 1.5)
- Assert the outcome (returned value, emitted message, state, log), not that a function was called.
- Expect errors, do not catch them: `await expect(run()).rejects.toThrow(BreakpointError)`. (Testing BP 1.10)
- Snapshots only inline and only a few lines long. (Testing BP 1.8)

## End-to-end tests

- They prove what unit tests can only fake: a real process, environment, console, event loop and exit. Keep them to
  what a real process adds; each one starts a process.
- A package's own: `packages/<name>/test/e2e/<component>/`, with a fixture app started as a child process, a
  harness that drives it, and one `<behavior>.test.ts` per behavior of the component, one `it` per scenario. They may
  import the package's sources by relative path, since they live in it. The whole system: in `examples/`, through the
  public API only.
- A run ends when the process exits by itself; a deadline after the last request only kills one that never does, and
  a run that fails earlier kills its process. No sleeps and no assertion on elapsed real time: order is shown by
  markers the fixture writes to the same output as the code under test.

## Type tests

- Only for public types whose shape is the contract (protocol, SDK public API): what a user can and cannot write.
- They live in `<module>.test-d.ts` next to the source (doc examples: see above) and use `expectTypeOf` and `assertType` only, never a
  runtime `expect`. Vitest does not run them; `pnpm typecheck` compiles them and fails on a broken assertion.
- A rejected shape: `// @ts-expect-error <reason>` directly above `assertType<T>(...)`, with the wrong field on the
  first line of the call, where tsc reports it.

```ts
// Bad: spies on internals; a type check padded with a runtime assertion
it("works", () => {
  const spy = vi.spyOn(manager, "internalSet");
  manager.add(bp);
  expect(spy).toHaveBeenCalled();
});
it("accepts a welcome", () => {
  const welcome: Welcome = { version: 1, type: "welcome" };
  expect(welcome.type).toBe("welcome");
});

// Good: index.test.ts
it("returns an error result when the inspector session is closed", async () => {
  const manager = createManager(closedSession());

  const result = await manager.add(bp);

  expect(result).toEqual({ ok: false, reason: "session-closed" });
});

// Good: index.test-d.ts
it("rejects a breakpoint without a line", () => {
  // @ts-expect-error line is required
  assertType<Breakpoint>({ id: "bp-1", file: "src/orders/checkout.ts" });
});
```

Source: [JavaScript Testing Best Practices](https://github.com/goldbergyoni/javascript-testing-best-practices).
