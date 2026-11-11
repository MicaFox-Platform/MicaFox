# Logger

## Purpose

The logger is how the SDK reports its own problems: one wrapper that the debugger and the connector write through,
which hands each line to the app's logger, or to `console` by default, without throwing into, blocking or flooding
the host app. It does not ship the app's own logs. How to use it: [API](../../api/sdk/logger.md).

## Boundaries

- Owns:
  - resolving `logger` and `logLevel`, and filtering lines below the level;
  - the message format and the [`LogContext`](../../api/sdk/logger.md#logcontext) of each line;
  - calling the app's logger safely;
  - collapsing repeats of a problem;
  - holding lines written while the thread is paused, and writing them after the pause.
- Does not own:
  - what is logged and at which level: the [debugger](debugger.md) and the [connector](connector.md);
  - keeping secrets out of messages: each call site passes URLs as origin and path only, and never the token or a
    captured value ([ADR 0006](../../adr/0006-authenticate-to-the-hub-with-a-bearer-token.md),
    [ADR 0012](../../adr/0012-redact-secrets-by-name-inside-the-sdk.md)).
- Constraints:
  - Never throws and never rejects. A logger method that throws is caught and its error is not logged, so a broken
    logger cannot recurse. A returned thenable gets `then(undefined, noop)` inside the same `try`, so a failing
    async logger cannot end the process with an unhandled rejection.
  - A line below the level costs one comparison. Code on the pause and send paths asks `enabled(level)` before it
    builds a message.
  - Memory is bounded: 100 collapse windows, each keeping its first message, and 100 held lines per logger.
  - One timer per logger, unref'd and running only while a collapse window is open, and one `setImmediate` after a
    `release()`.
  - Calls the app's logger synchronously, as a method: `logger[level](message, context)`, and does not retry; only a
    pause holds lines back. The default `console` writes to stdout and stderr, which can block the event loop when
    the reader is slow; the default level and collapsing keep that rare.
  - Imports only Node built-ins and no other SDK module, so it moves with the connector if the connector becomes
    its own package.

## Interactions

```text
┌───────────┐  log(), enabled(), hold(), release(), flush()  ┌──────────────────────────────┐
│ Debugger  │ ──────────────────────────────────────────────▶│            Logger            │
└───────────┘                                                │  level filter · collapsing   │
┌───────────┐  log(), enabled(), flush()                     │    pause hold · safe call    │
│ Connector │ ──────────────────────────────────────────────▶│                              │
└───────────┘                                                └──────────────────────────────┘
                                                                            │ debug|info|warn|error(message, context)
                                                                            ▼
                                                             ┌──────────────────────────────┐
                                                             │    App logger or console     │
                                                             └──────────────────────────────┘
```

The logger lives in `packages/sdk/src/logger/`. The debugger keeps one logger for its lifetime; `configure()` and
`run()` change its target and level. It passes that logger to the `HubConnector` it creates, in the constructor
options under the key `Symbol.for("micafox.logger")`, which is not part of `HubConnectorOptions`, so one logger
serves both. A `HubConnector` the app creates, also one passed as `connector`, builds its own logger from its
options.

Levels:

- `error` — MicaFox cannot do its job until something outside it changes, or a bug in the SDK or the hub: an invalid
  URL, a rejected token, an unserializable message, an oversize frame, the debugger stopping itself.
- `warn` — a problem MicaFox recovers from, or one that loses data: a reconnect, dropped messages, an invalid option
  replaced by its default.
- `info` — the lifecycle: started, stopped, turned off by `MICAFOX_ENABLED`.
- `debug` — details for diagnosing MicaFox itself: an unknown message type, how a breakpoint was resolved.

## Layout

```text
packages/sdk/src/logger/
├── index.ts         the logger's only entry: createLogger, SdkLogger and the public types
├── logger.ts        SdkLogger: options, level filter, collapsing and holding lines during a pause
├── app-logger.ts    the Logger the app passes and calls to it that never throw
├── context.ts       the fields of a log line and readErrorCode
├── level.ts         log levels and the default level
├── collapse.ts      collapses repeats of one problem into a summary line
├── line-queue.ts    the bounded queue of lines held during a pause
└── pause-hold.ts    the process-wide pause state shared by every logger
```

## Key flows

### Resolving the logger

1. Before `run()`, the debugger's logger writes to `console`. Its level is read from `MICAFOX_LOG_LEVEL` when the
   first line is written, or is `warn`. A `configure()` call that sets `logger` or `logLevel` applies them first,
   so its own warnings already use them.
2. `run()` resolves both like every option: the value from `configure()`, then `MICAFOX_LOG_LEVEL`, then `warn`. See
   [ADR 0003](../../adr/0003-configure-the-sdk-from-options-then-env.md) and, for `configure()` at other
   times, [calls in any order](../../api/sdk/debugger.md#micafox).
3. `new HubConnector(options)` resolves them the same way in its constructor, unless it got the debugger's logger.
4. An invalid `logLevel` or `MICAFOX_LOG_LEVEL` logs a warning and `warn` is used. A `logger` that is not an object
   with the four methods logs a warning to `console`, and `console` is used. The warnings carry the component of the
   caller that set the options: `debugger` for `configure()` and `run()`, `connector` for `new HubConnector()`.
   Before any options are set, the warning about `MICAFOX_LOG_LEVEL` carries the logger's owner and goes to
   `console`. Like every line, these warnings are written only when the resolved level lets `warn` through.
5. `MICAFOX_LOG_LEVEL` takes the level names exactly; an empty value counts as unset. An invalid value is reported
   once per logger, however often the options are set.

### Writing a line

1. A call site passes the level, a message and the fields it has, among them a fixed `key` naming the problem.
2. A line below the level is dropped at once.
3. A repeat inside an open collapse window is counted and dropped, see [Collapsing repeats](#collapsing-repeats).
4. The message becomes `[micafox] <component>: <message>`. Text from outside the SDK, such as error messages and URL
   paths, is passed as it is.
5. The context always has `component`, and all its values are plain and serializable. An `Error` becomes
   `{ name, message, code, stack }`, because JSON output turns an `Error` into `{}`; a thrown value that is not an
   `Error` becomes `{ name: "NonError", message: String(value) }`; `code` is `String(code)` when present. Every
   read is guarded, so a hostile error object cannot throw.
6. While a pause is held, the line is queued, see [Holding lines during a pause](#holding-lines-during-a-pause).
7. Otherwise the app's logger is called as `logger[level](message, context)`. The default `console` is called as
   `console[level](message)`.

### Collapsing repeats

1. A problem is identified by the line's level, the call site's key, the `breakpointId` and the error's `code`,
   so a different breakpoint or error code is logged in full, and an `error` is never hidden behind a `warn`.
   A line without a `key` is never collapsed; the key is not part of the context.
2. Its first occurrence is logged in full and opens a 60 s window, timed by the monotonic clock so that a
   wall-clock step cannot stretch it. Repeats inside the window are only counted.
3. When the window ends with repeats, one line at the same level says `<first message> (repeated N times in S s)`,
   with the first line's context plus `count`. S is the window's age in whole seconds: 60 when it expires, less
   when the cap or a flush ends it early, more when a blocked event loop delays the timer. A window without repeats
   ends silently. The next occurrence is logged in full again.
4. At most 100 windows are open. Opening another ends the oldest early, with its summary line.

### Holding lines during a pause

1. The debugger calls `hold()` when its `Debugger.paused` handler starts and `release()` in its `finally`, so the
   thread is never paused while the app's logger runs, also when the debugger stops itself during the pause.
2. The hold is one flag for the whole process, kept in a record on `globalThis` under
   `Symbol.for("micafox.logger.hold")`: `hold()` on any logger makes every logger queue its lines, also one from
   another copy or version of the SDK. A second `hold()` does nothing, one `release()` ends it, and `release()`
   without `hold()` does nothing. A copy reads the record defensively and adds what an older one left out.
3. Each logger keeps its own queue, of lines that passed the level filter and collapsing, summaries included. At 100,
   the oldest is dropped and counted.
4. `release()` writes nothing at once. In a `setImmediate`, after the thread resumes, every logger with a queue writes
   it in order, then one warning with the number of dropped lines, if any. The warning carries the `component` of
   the oldest dropped line and, like every line, is written only when the level lets `warn` through. Lines written
   before the immediate runs join the queue, so the order holds. If `hold()` is called again first, nothing is
   written and the lines wait for the next `release()`.

### Flushing

1. `micafox.stop()` and `HubConnector.close()` flush the logger before they resolve: its queued lines and the dropped
   lines warning, then the summaries of open windows, are written, and the timer stops. The pending `setImmediate`
   of `release()` is cancelled unless another logger's queue still waits for it.
2. While held, `flush()` writes no queued line and leaves the queue for `release()`; the summaries of the closed
   windows join it.
3. Lines written later, such as warnings about calls after `close()`, are still logged.

## Decisions

- [0003. Configure the SDK from options, then env](../../adr/0003-configure-the-sdk-from-options-then-env.md)
- [0014. Pass SDK logs as a full message and a context](../../adr/0014-pass-sdk-logs-as-a-full-message-and-a-context.md)
- [0015. Filter SDK logs by level before the app's logger](../../adr/0015-filter-sdk-logs-by-level-before-the-apps-logger.md)
