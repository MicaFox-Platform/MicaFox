---
paths:
  - "packages/sdk/**"
---

# SDK

The SDK runs inside someone else's production app. Being invisible matters more than being clever.

- Never block the event loop: no sync I/O, no busy loops, no unbounded work on the hot path.
- Overhead budget: a disabled breakpoint costs ~0; a snapshot is bounded in depth, size and time.
- Errors stop at the boundary: public API methods, hooks into host code, and event, timer and socket callbacks.
  Inside, code throws typed errors, except where the architecture doc says a component returns results. The
  boundary catches and turns the error into the documented result, a no-op or the documented recovery (the debugger
  stops itself; a paused thread is resumed in `finally`); it never rethrows.
- An async callback catches inside itself: a `try` around a call that returns a promise misses its rejection, and an
  unhandled rejection kills the host process.
- Log through the SDK's logger only: it never throws, and a user logger that throws is ignored.
- No heavy runtime dependencies; prefer Node built-ins. A new dependency needs an ADR.

```ts
// Bad
session.on("Debugger.paused", (event) => {
  send(capture(event)); // throws into the host app on any failure
});

// Good
session.on("Debugger.paused", (event) => {
  try {
    send(capture(event, { maxDepth: 3, timeoutMs: 10 }));
  } catch (error) {
    logger.warn("snapshot failed", error);
  } finally {
    resume();
  }
});
```
