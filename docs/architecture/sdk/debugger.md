# Debugger

## Purpose

The debugger is the part of the SDK that sets breakpoints in the running app and captures snapshots without
stopping it. It turns the hub's breakpoint list into V8 breakpoints, reads the variables at each hit within strict
limits, redacts secrets and sends them to the hub through a connector. How to use it: [API](../../api/sdk/debugger.md).

## Boundaries

- Owns:
  - the lifecycle of [`probex`](../../api/sdk/debugger.md#probex): options, `run()`, `stop()`, the connector it
    creates and the [logger](logger.md) it shares with that connector;
  - the in-process inspector session and the V8 breakpoints in it;
  - matching repository paths and TypeScript lines to loaded scripts through source maps;
  - capturing snapshots and cutting values to [`CaptureLimits`](../../api/protocol.md#capturelimits);
  - redacting secrets by name before a value is read;
  - rate limits, the pause budget and the status of each breakpoint.
- Does not own:
  - moving messages, buffering and reconnects: the [connector](connector.md);
  - message types: the [protocol](../protocol.md);
  - which breakpoints exist: the hub;
  - filtering, collapsing and writing log lines: the [logger](logger.md).
- Constraints:
  - Never throws into, crashes or blocks the host app. Every handler is wrapped in try/catch; an unexpected error is
    logged and the debugger stops itself while the app keeps running.
  - Every pause ends in `Debugger.resume`, also after an error. If resuming fails, `Debugger.disable` resumes the
    thread and the debugger stops itself.
  - A pause lasts at most 10 ms, the app spends at most 20 ms per second paused, and a snapshot is at most 64 KiB.
    Every pause counts, also one resumed at once. Log lines written during a pause are held and written after it;
    the pause path builds a log message only when its level is enabled.
  - No single inspector call reads an unbounded value: an array, typed array, `Set` or `Map` with more children
    than `maxItems` is captured with its size only. An object's own properties are read in one call, so an object
    with a very large number of own properties can make that one pause longer than 10 ms.
  - Without breakpoints the inspector's `Debugger` domain is off, so V8 runs the app as if ProbeX were not there.
  - Runs no user code: getters are never called and nothing is evaluated.
  - A redacted value never reaches the snapshot or the logs: a container under a redacted name is never expanded,
    and a primitive, which V8 returns with its siblings in one `Runtime.getProperties` reply, is dropped there.
    Only the host app sets the redaction rules; the hub cannot change them.
  - One debugger per process: the first copy of the SDK loaded stores its `Debugger` on `globalThis` under
    `Symbol.for("probex.debugger")`, and every later copy, an ES module or CommonJS build or another install,
    exports that object. A copy of another major version logs a warning and exports it too.
  - Debugs the main thread only; worker threads are not debugged.
  - Does not start when the inspector is already open at `run()`, by `--inspect` or `inspector.open()`.
  - Resumes every pause it did not cause, including `debugger` statements, so another debugger attached to the
    process does not work while breakpoints are set.
  - Memory is bounded: 100 breakpoints, source maps up to 8 MiB each, decoded only for scripts that have
    breakpoints and dropped with them. Only scripts with a `file:` URL or an absolute path are recorded, one record
    per URL; scripts without a URL, such as `eval` and `new Function`, are ignored.
  - Reads source maps inline (`data:` URLs) or from a relative `sourceMappingURL` resolved against the script's
    path; any other scheme gives the breakpoint status `error`. Bundles, where many sources map into one script,
    are not supported.
  - Imports only `@probex-platform/protocol`, the connector and logger modules and Node built-ins; source maps are
    decoded by its own VLQ decoder.
  - Never keeps the host process alive: every timer is unref'd. While `stop()` flushes the connector it created,
    the connector keeps the process alive, see [Closing](connector.md#closing).

## Interactions

```text
┌───────────┐  breakpoints        ┌──────────┐   log, hold, release         ┌────────┐
│ Connector │ ──────────────────▶ │ Debugger │ ───────────────────────────▶ │ Logger │
│           │ ◀────────────────── │          │                              └────────┘
└───────────┘ statuses, snapshots └──┬────┬──┘
                                     │    ▲
                               apply │    │ statuses, snapshots
                                     ▼    │
        ┌────────────────────────────┴────┴────────────────────────┐
        │                       Breakpoints                        │
        └─────┬──────────────────┬─────────────────┬────────┬───┬──┘
              │                  │                 │        │   ▲
              │ resolve file:line│ allow hit?      │ capture│   │
              │                  │                 │        │   │ set, remove, resume ▼
              ▼                  ▼                 ▼        │   │
        ┌────────────┐    ┌─────────────┐     ┌─────────┐   │   │ ▲ scriptParsed, paused
        │ SourceMaps │    │ RateLimiter │     │ Capture │   │   │
        └────────────┘    └─────────────┘     └────┬────┘   │   │
                                                   │        │   │
                                     getProperties │        │   │
                                                   ▼        ▼   │
                                        ┌──────────┴────────┴───┴──┐  Debugger.*, Runtime.*     ┌────┐
                                        │     InspectorSession     │ ─────────────────────────▶ │ V8 │
                                        │                          │ ◀───────────────────────── │    │
                                        └──────────────────────────┘  scriptParsed, paused      └────┘

```

The parts live in `packages/sdk/src/debugger/`:

- `Debugger` — the `probex` object. Resolves the options, creates the logger, the connector and the parts below,
  hands `breakpoints` messages to `Breakpoints` and sends what they produce. It is not running, running or
  stopping.
- `Breakpoints` — holds the latest list from the hub, the V8 breakpoint of each entry and its status, and handles
  every pause.
- `SourceMaps` — finds the script and position for a repository path and line, and the original position for a
  script position.
- `RateLimiter` — token buckets per breakpoint and per process, and the pause budget.
- `Capture` — reads the stack and variables of a paused frame into a [`Snapshot`](../../api/protocol.md#snapshot),
  and redacts secrets by name as it goes.
- `InspectorSession` — wraps `node:inspector`. On the main thread, `post` answers synchronously, also while the
  thread is paused; failures come back as results and are never thrown.

## Layout

```text
packages/sdk/src/debugger/
├── index.ts                the debugger's only entry: Debugger, InspectorSession and their types
├── debugger.ts             Debugger: configure(), run() and stop(), and the not running, running and stopping states
├── options.ts              DebuggerOptions, the fields of a configure() call, enabled and the custom connector check
├── connector-link.ts       ConnectorLink: subscribes to a connector, connects it and catches what an async one rejects
└── inspector-session.ts    InspectorSession: node:inspector calls that answer synchronously and never throw
```

`Breakpoints`, `SourceMaps`, `RateLimiter` and `Capture` get their own sub-component folders when they are built.

## Key flows

### Starting

1. `run()` with `enabled` false logs one info line and does nothing. When `inspector.url()` returns a URL, another
   debugger may be attached: it logs a warning and does nothing.
2. It resolves the options: the value from `configure()`, then the environment, then the default. Without a hub URL
   and without a custom connector it logs an error and does not start.
3. It creates a `HubConnector` or takes the custom one, subscribes to its messages and status, and calls
   `connect()`. When a custom connector reports `closed`, the debugger logs a warning and stops itself.
4. It connects the inspector session; the `Debugger` domain stays off until there are breakpoints.
5. If any step fails, an error is logged, what was started is stopped and the debugger is not running.

### Applying breakpoints

1. A [`breakpoints`](../../api/protocol.md#breakpoints) message arrives. Only its first 200 entries are read; the
   rest are ignored with one warning. An entry without a string `id` is skipped with a warning. An invalid entry,
   such as a limit that is not a positive integer, and those after the 100th get status `error`. When an `id`
   appears more than once, the first entry is used and the others are ignored with a warning.
2. Entries are compared by `id` with the current ones. An entry with the same `file`, `line` and `limits` is left
   as it is, with no V8 calls. Removed and changed entries lose their V8 breakpoint; new and changed entries are
   resolved.
3. The first non-empty list turns the `Debugger` domain on: V8 reports every loaded script with `scriptParsed`, and
   later ones as they load. An empty list turns it off.
4. Resolving: script URLs are turned from `file://` into paths, map sources are resolved against the map's
   `sourceRoot` and URL, and all paths use `/`. Candidates are scripts with a source map whose sources include a
   path ending in the entry's last segment, and scripts without one whose path does, extension included. The
   candidate whose path ends with the most segments of `file` wins; a tie gives status `error`, no candidate gives
   `pending`. A candidate whose map is still loading keeps the entry `pending`, see
   [Loading a source map](#loading-a-source-map).
5. The line is mapped to the first generated position of that original line, or of the next line that has one, and
   the breakpoint is set with `Debugger.setBreakpointByUrl` by the script's URL and position, so V8 also sets it in
   every later script with the same URL, such as a module reloaded by a test runner. V8 moves it to the next
   position that has code. Entries that resolve to the same URL and position share one V8 breakpoint, which is
   removed with the last of them.
6. After each message, the status of every listed breakpoint is sent as a
   [`breakpointStatus`](../../api/protocol.md#breakpointstatus), a control message. Later changes, such as a map
   finishing to load or a rate limit, are sent when they happen.
7. A `pending` breakpoint is resolved again on every `scriptParsed` with a matching file name. A script with the
   URL of a recorded one replaces it.

### Loading a source map

1. On `scriptParsed`, the script's URL and `sourceMapURL` are recorded; nothing is read.
2. When a breakpoint needs the map, a `data:` URL is decoded in place; a relative URL is resolved against the
   script's path and read with `node:fs/promises`. Entries that need the same map share one read.
3. When the read ends, each waiting entry is set only if it is still listed with the same fields and the debugger
   is running.
4. A map larger than 8 MiB, unreadable or invalid gives the breakpoint status `error` with the reason and logs a
   warning.
5. The mappings are decoded into indexes from original line to generated position and back, kept while the script
   has breakpoints. A breakpoint on a module's top-level code can miss the module's first run, because a map file
   is read after the script is loaded.

### Capturing a snapshot

1. V8 reaches a breakpoint and pauses the thread; `Debugger.paused` reaches the session synchronously. The
   [logger holds](logger.md#holding-lines-during-a-pause) every line until the handler returns.
2. A pause without one of our breakpoints in `hitBreakpoints` is resumed at once.
3. The rate limiter checks each entry on the hit V8 breakpoint. Each entry's bucket holds 10 tokens and the
   process bucket 50, refilled continuously at that many per second; the pause budget is 20 ms per second. An
   entry is allowed if it has a token, the process has one and the budget is not spent; each allowed entry takes
   one of each. With no entry allowed the thread resumes.
4. An entry out of tokens gets status `rateLimited`; once every entry on a V8 breakpoint is out of tokens, the V8
   breakpoint is removed. When the process bucket or the budget is empty, `Debugger.setBreakpointsActive(false)`
   turns every breakpoint off and the affected entries get `rateLimited`. One unref'd timer restores breakpoints
   and sends `active` when the buckets and the budget are full again, so a hot line stops pausing.
5. `Capture` reads up to 20 frames of the stack, then `this` and the scopes of the innermost frame with synchronous
   `Runtime.getProperties` calls, depth first, within the largest limits of the allowed entries. Frames are mapped
   to original positions where the script's map is decoded; others keep the generated path and position. The size
   of an array, typed array, `Set` or `Map` comes from V8's description of it; with more children than `maxItems`
   only the size is kept, without reading them. At 10 ms or 64 KiB it stops: what is left is `unavailable` and
   the snapshot is `truncated`. A name that matches the redaction rules, see [Redacting secrets](#redacting-secrets),
   gets the value `redacted` and its children are not read.
6. The thread resumes, and the pause time, from the start of the handler, is charged to the budget, also for a
   pause resumed at once. One pause serves every entry on the breakpoint.
7. For each allowed entry, the capture is cut to that entry's own limits, without V8 calls, and sent as a
   [`snapshot`](../../api/protocol.md#snapshot) through the connector as a data message.

### Redacting secrets

1. At `run()` the rules are resolved once: the built-in names, plus the names from `redact` and from
   `PROBEX_REDACT`. The app adds names; it cannot remove the built-in ones.
2. Names are normalized before matching: lowercased, with `_`, `-` and `.` removed, so `api_key`, `API-KEY` and
   `apiKey` are all `apikey`. A rule that is empty after normalizing is skipped with a warning.
3. A name matches when its normalized form contains a normalized rule, so `dbPassword` matches `password`. A
   false match hides a harmless value; a missed one leaks a secret, so matching errs towards hiding.
4. Rules apply to every name in the tree at any depth: variables, `this`, object properties and map entries whose
   key is a string. Array items have no name and are not matched.
5. A matching name keeps its place with the value `{ type: "redacted" }`; its children are never read, and a
   primitive value that came with its siblings is dropped.
6. Built-in names: `password`, `passwd`, `pwd`, `secret`, `token`, `apikey`, `accesskey`, `privatekey`,
   `credential`, `authorization`, `cookie`, `session`, `jwt`, `bearer`, `signature`.
7. String contents are not scanned: a secret inside a value under a harmless name, such as a URL with a password,
   is captured as is.

### Losing the connection

1. Breakpoints stay set and snapshots wait in the connector's data buffer, which drops the oldest when full.
2. After the reconnect the hub sends the full list again, and it is applied like any other.

### Stopping

1. `stop()` removes every V8 breakpoint, turns the `Debugger` domain off, disconnects the inspector session and
   unsubscribes from the connector. Source map reads still running are ignored when they end.
2. It closes the connector it created, which sends buffered snapshots for up to `closeTimeoutMs`; a custom
   connector is left open.
3. It [flushes the logger](logger.md#flushing). The debugger is not running; `run()` can start it again.
4. An unexpected error in any part logs an error and runs the same steps, so the app keeps running without the
   debugger.

## Decisions

- [0003. Configure the SDK from options, then env](../../adr/0003-configure-the-sdk-from-options-then-env.md)
- [0007. Deliver messages to the hub at most once](../../adr/0007-deliver-messages-to-the-hub-at-most-once.md)
- [0010. Send the full breakpoint set on every change](../../adr/0010-send-the-full-breakpoint-set-on-every-change.md)
- [0011. Encode snapshot values as a nested tree](../../adr/0011-encode-snapshot-values-as-a-nested-tree.md)
- [0012. Redact secrets by name inside the SDK](../../adr/0012-redact-secrets-by-name-inside-the-sdk.md)
- [0013. Publish the packages as ES modules and CommonJS](../../adr/0013-publish-the-packages-as-es-modules-and-commonjs.md)
