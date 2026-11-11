# Debugger

## Purpose

The debugger is the part of the SDK that sets breakpoints in the running app and captures snapshots without
stopping it. It turns the hub's breakpoint list into V8 breakpoints, reads the variables at each hit within strict
limits, redacts secrets and sends them to the hub through a connector. How to use it: [API](../../api/sdk/debugger.md).

## Boundaries

- Owns:
  - the lifecycle of [`micafox`](../../api/sdk/debugger.md#micafox): options, `run()`, `stop()`, the connector it
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
    than `maxItems` is captured with its size only. Two values are exceptions, as V8 returns them whole in one
    reply: an object's own properties are read in one call, and a string comes in full with the object or scope that
    holds it and is cut afterwards. An object with a very large number of own properties, or a string of many
    megabytes, can make that one pause longer than 10 ms and cost its size in memory until the pause ends.
  - Without breakpoints the inspector's `Debugger` domain is off, so V8 runs the app as if MicaFox were not there.
  - Runs no user code: getters are never called and nothing is evaluated.
  - A redacted value never reaches the snapshot or the logs: a container under a redacted name is never expanded,
    and a primitive, which V8 returns with its siblings in one `Runtime.getProperties` reply, is dropped there.
    Only the host app sets the redaction rules; the hub cannot change them.
  - One debugger per process: the first copy of the SDK loaded stores its `Debugger` on `globalThis` under
    `Symbol.for("micafox.debugger")`, and every later copy, an ES module or CommonJS build or another install,
    exports that object. A copy of another major version logs a warning and exports it too.
  - Debugs the main thread only; worker threads are not debugged.
  - Does not start when the inspector is already open at `run()`, by `--inspect` or `inspector.open()`.
  - Resumes every pause it did not cause, including `debugger` statements, so another debugger attached to the
    process does not work while breakpoints are set.
  - Memory is bounded: 100 breakpoints, source maps up to 8 MiB and 1,500,000 segments each, about 36 MB decoded,
    read one at a time only for scripts that may hold an entry's file, and kept decoded only for scripts that have
    breakpoints. Only scripts with a `file:` URL or an absolute path are recorded, one record per URL; scripts
    without a URL, such as `eval` and `new Function`, are ignored. Every script with a URL is also kept by its id, at
    most 20,000, the oldest dropped first, because V8 names the script of a call frame by id only.
  - Reads source maps inline (`data:` URLs) or from a relative `sourceMappingURL` resolved against the script's
    path; a map with any other scheme is not read, and an entry that nothing else resolves gets the status `error`.
    Bundles, where many sources map into one script, are not supported.
  - Imports only `@micafox/protocol`, the connector and logger modules and Node built-ins; source maps are
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
              │ read map, sources│ allow hit?      │ capture│   │
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

- `Debugger` — the `micafox` object. Resolves the options and the redaction rules, creates the logger, the connector
  and the parts below, hands `breakpoints` messages to `Breakpoints` and sends what they produce. It is not running,
  running or stopping.
- `Breakpoints` — holds the latest list from the hub, the V8 breakpoint of each entry and its status, and handles
  every pause.
- `SourceMaps` — reads the maps of loaded scripts, one at a time, and keeps their resolved sources and, while a
  breakpoint is set through one, its index from original line to generated position and back. `Breakpoints` finds
  an entry's script and position with them.
- `RateLimiter` — token buckets per breakpoint and per process, and the pause budget.
- `Capture` — reads the stack and variables of a paused frame into one read, and cuts that read to the limits of
  each breakpoint as a [`Snapshot`](../../api/protocol.md#snapshot). It asks `Breakpoints` where a frame is shown,
  and redacts secrets by name as it goes.
- `InspectorSession` — wraps `node:inspector`. On the main thread, `post` answers synchronously, also while the
  thread is paused; failures come back as results and are never thrown.

## Layout

```text
packages/sdk/src/debugger/
├── index.ts                    the debugger's only entry: Debugger, InspectorSession and their types
├── debugger.ts                 Debugger: configure(), run(), stop(), and the not running, running and stopping states
├── options.ts                  DebuggerOptions: the fields of a configure() call, enabled, the custom connector check
├── connector-link.ts           ConnectorLink: subscribes to, connects and sends to a connector; catches its rejections
├── inspector-session.ts        InspectorSession: node:inspector calls that answer synchronously and never throw
├── breakpoints/                Breakpoints: the hub's list as V8 breakpoints, their statuses and every pause
│   ├── index.ts                the sub-component's only entry: Breakpoints
│   ├── breakpoints.ts          Breakpoints: applies a list, resolves pending entries, resumes every pause, stops
│   ├── entry.ts                ValidEntry, InvalidEntry, the comparison of two entries and the status of an outcome
│   ├── read-list.ts            reads and validates the entries of a breakpoints message, with the limits on the list
│   ├── script-registry.ts      ScriptRegistry: the loaded scripts, one per URL, by file name, by base name and by id
│   ├── find-location.ts        findLocation: an entry's script and position, or the maps it waits for
│   ├── match-path.ts           picks the candidate whose path ends with the most segments of an entry's file
│   └── v8-breakpoints.ts       V8Breakpoints: Debugger.setBreakpointByUrl and removeBreakpoint, shared by position
├── capture/                    Capture: one pause read into values within the limits, then cut per breakpoint
│   ├── index.ts                the sub-component's only entry: readPause, cutSnapshot and their types
│   ├── read-pause.ts           readPause: the call frames, the stack and the variables of the innermost frame
│   ├── read-value.ts           ValueReader: a value and what is below it with Runtime.getProperties, depth first
│   ├── read-primitive.ts       the values that V8 describes in full: primitives, null, Date, and the size of a container
│   ├── remote-object.ts        RemoteObject, Property and the reading of a Runtime.getProperties reply
│   ├── limits.ts               ResolvedLimits: defaults, caps and the largest of several, and truncateText
│   ├── budget.ts               CaptureBudget: the 10 ms and 64 KiB of a capture, and the size of a value
│   └── cut-snapshot.ts         cutSnapshot: a read cut to one breakpoint's limits as a Snapshot, with no V8 call
├── redaction/                  RedactionRules: the names whose values are redacted, resolved once at run()
│   ├── index.ts                the sub-component's only entry: resolveRedaction and RedactionRules
│   ├── redaction-rules.ts      RedactionRules: the built-in names, normalizeName and the match by containment
│   └── resolve-redaction.ts    resolveRedaction: the built-in names plus redact and MICAFOX_REDACT, at most 100
├── source-maps/                SourceMaps: reads the maps of loaded scripts and keeps what each one is needed for
│   ├── index.ts                the sub-component's only entry: SourceMaps, locateFrame and the types of what it knows
│   ├── source-maps.ts          SourceMaps: one read per script record, shared; the index kept while an entry holds it
│   ├── read-source-map.ts      readSourceMap: a data: URL in place or a relative file with node:fs/promises, 8 MiB
│   ├── map-sources.ts          resolveMapSources: the sources of a map against its sourceRoot and URL, as paths
│   └── locate-frame.ts         locateFrame: the file, line and column a frame is shown at, original or generated
└── source-map-decoder/         decodeSourceMap: the text of a map into its two indexes, in slices
    ├── index.ts                the sub-component's only entry: decodeSourceMap and the types of its result
    ├── decode-source-map.ts    decodeSourceMap: checks the size, runs the steps below in slices, never throws
    ├── parse-source-map.ts     checks the JSON's depth and number of values in slices, parses it, reads the fields
    ├── decode-mappings.ts      VlqCursor and the mappings string read into segments in generated order
    ├── sort-by-original.ts     orders the segments by source and original line, first generated position first
    ├── source-map-index.ts     SourceMapIndex: original line to generated position, generated position to original
    ├── sliced-work.ts          WorkBudget and runSliced: slices of fixed work with a yield to the event loop between
    └── source-map-error.ts     SourceMapError: the fixed reason of a map that cannot be decoded
```

`RateLimiter` gets its own sub-component folder when it is built. `Breakpoints` uses `source-maps/`, which uses
`source-map-decoder/`; `Capture` uses `source-maps/` only for the type of a frame's position, which it gets from
`Breakpoints.locateFrame`. `Debugger` uses `redaction/`; `Capture` gets only its `isSecret`.

## Key flows

### Starting

1. `run()` with `enabled` false logs one info line and does nothing. When `inspector.url()` returns a URL, another
   debugger may be attached: it logs a warning and does nothing.
2. It resolves the options: the value from `configure()`, then the environment, then the default. Without a hub URL
   and without a custom connector it logs an error and does not start.
3. It resolves the [redaction rules](#redacting-secrets), once. It creates a `HubConnector` or takes the custom one,
   subscribes to its messages and status, and calls `connect()`. When a custom connector reports `closed`, the
   debugger logs a warning and stops itself.
4. It connects the inspector session; the `Debugger` domain stays off until there are breakpoints.
5. If any step fails, an error is logged, what was started is stopped and the debugger is not running.
6. It logs one info line, `started`, with the number of redaction rules.

### Applying breakpoints

1. A [`breakpoints`](../../api/protocol.md#breakpoints) message arrives. Only its first 200 entries are read; the
   rest are ignored with one warning. An entry without a string `id` is skipped with a warning. An invalid entry,
   such as a limit that is not a positive integer, and those after the 100th get status `error`. When an `id`
   appears more than once, the first entry is used and the others are ignored with a warning.
2. Entries are compared by `id` with the current ones. An entry with the same `file`, `line` and `limits` is left
   as it is, with no V8 calls. Removed and changed entries lose their V8 breakpoint; new and changed entries are
   resolved.
3. The first list with a valid entry turns the `Debugger` domain on: V8 reports every loaded script with
   `scriptParsed`, and later ones as they load. A list without one, such as an empty list, turns it off.
4. Resolving: script URLs are turned from `file://` into paths, map sources are resolved against the map's
   `sourceRoot` and URL, and all paths use `/`. Candidates are the sources of the maps of scripts whose file name
   without its extension equals the entry's, such as `dist/checkout.js` for `src/checkout.ts`, that end in the
   entry's last segment, and scripts without a map whose path does, extension included. The candidate whose path
   ends with the most segments of `file` wins; a tie gives status `error`, no candidate gives `pending`, or `error`
   with the reason of a map that could not be used. While a map of such a script is unread or loading, the entry
   stays `pending`, see [Loading a source map](#loading-a-source-map).
5. The line is mapped to the first generated position of that original line, or of the next line that has one, and
   the breakpoint is set with `Debugger.setBreakpointByUrl` by the script's URL and position, so V8 also sets it in
   every later script with the same URL, such as a module reloaded by a test runner. V8 moves it to the next
   position that has code. Entries that resolve to the same URL and position share one V8 breakpoint, which is
   removed with the last of them.
6. After each message, the status of every listed breakpoint is sent as a
   [`breakpointStatus`](../../api/protocol.md#breakpointstatus), a control message. Later changes, such as a map
   finishing to load or a rate limit, are sent when they happen.
7. A `pending` breakpoint is resolved again on every `scriptParsed` with a matching file name, or with a matching
   base name for a script with a map, and when a map it waits for is read. A script with the URL of a recorded one
   replaces it, and its map is read again when it is needed.

### Loading a source map

1. On `scriptParsed`, the script's URL and `sourceMapURL` are recorded; nothing is read.
2. An entry needs the maps of the recorded scripts with a `sourceMapURL` whose file name without its last extension
   equals that of the entry's `file`: `checkout.js` and `checkout.mjs` for `checkout.ts`, `checkout.test.js` for
   `checkout.test.ts`. Maps of other scripts are never read. A `data:` URL with the `application/json` media type
   is decoded in place; a URL without a scheme is resolved against the script's path and read with
   `node:fs/promises`; any other scheme, `file:` included, is not read. Maps are read one at a time, entries that
   need the same map share one read, and a map is read once per script record and again only to bring back a
   dropped index.
3. When the read ends, the entries still waiting for it are resolved again from the current list, so an entry is
   set only if it is still listed with the same fields; after `stop()` or with the domain off the read is ignored.
4. A map larger than 8 MiB, unreadable, invalid or with another scheme logs a warning and is left out of resolving;
   an entry with no other candidate gets the status `error` with the reason, and is resolved again when a script
   it may match loads. Other entries are unaffected.
5. The mappings are decoded into indexes from original line to generated position and back. The index is kept while
   the script has breakpoints set through it and dropped with the last one; for other scripts only the resolved
   sources are kept, so a pending entry does not read their maps again, and a script that wins later is read
   again. Both are dropped with the script's record. Decoding runs in slices of fixed work and yields to the event
   loop between them. Only `JSON.parse` runs in one piece; a check before it bounds the text to a depth of 8 and
   50,000 values, which keeps it to a few milliseconds. Index maps (`sections`), mappings that are not in generated
   order and maps of more than 1,500,000 segments are invalid; a `null` entry of `sources` maps to nothing. A
   breakpoint on the top-level code of a module with a source map, inline or in a file, can miss the module's first
   run, because the map is read and decoded after the script is loaded.

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
   `Runtime.getProperties` calls, depth first, within the largest limits of the allowed entries. V8 names the script
   of a frame by id, so `Breakpoints` finds its URL by id and gives the position: the original one where the script's
   map is decoded, else the generated path (from `file://`) or URL. The scopes read are `local`, `block`, `catch`,
   `with`, `eval`, `closure` and `module`; `global` and `script` are left out. An object keeps its own enumerable
   properties, read in one call; a getter is `accessor` and never run. The size of an array, typed array, `Set` or
   `Map` comes from V8's description of it; with more children than `maxItems` only the size is kept, without
   reading them. A function's name and an error's message and stack cost one call each; a date comes from its
   description, to the second. V8 gives no object identity, so a cycle is read again down to `maxDepth` and
   `circular` is never produced. At 10 ms or 64 KiB it stops: the first value not read is `unavailable` with the
   reason, the rest is left out (an object is `truncated`, an array, `Set` or `Map` loses its children) and the
   snapshot is `truncated`. A name that matches the redaction rules, see [Redacting secrets](#redacting-secrets),
   gets the value `redacted` and its children are not read.
6. The thread resumes, and the pause time, from the start of the handler, is charged to the budget, also for a
   pause resumed at once. One pause serves every entry on the breakpoint.
7. For each allowed entry, the capture is cut to that entry's own limits, without V8 calls, and sent as a
   [`snapshot`](../../api/protocol.md#snapshot) through the connector as a data message.

### Redacting secrets

1. At `run()` the rules are resolved once: the built-in names, plus the names from `redact` and from
   `MICAFOX_REDACT`, at most 100 together, copied from the app's array entry by entry. The app adds names; it cannot
   remove the built-in ones.
2. Names are normalized before matching: lowercased, with `_`, `-` and `.` removed, so `api_key`, `API-KEY` and
   `apiKey` are all `apikey`. A rule that is empty after normalizing is skipped with a warning.
3. A name matches when its normalized form contains a normalized rule, so `dbPassword` matches `password`. Only
   its first 256 characters are matched, so a map keyed by huge strings costs little per entry. A
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
