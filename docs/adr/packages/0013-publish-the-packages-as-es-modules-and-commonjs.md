# 0013. Publish the packages as ES modules and CommonJS

## Status

Accepted · 2026-10-26

## Context

Many Node.js apps that would embed the SDK still load packages with `require()`. MicaFox supports Node.js 22 or
later, but `require()` of an ES module works only from 22.12, is still experimental in Node 22, and on some 22.x
releases prints an `ExperimentalWarning` to the host app's stderr. TypeScript before 5.8 refuses to compile a
CommonJS file that imports a package that ships only ES modules. The SDK must stay invisible in the host app, and
it must work on every Node 22 release. Custom connectors and hubs import `@micafox/protocol`, so it has the
same consumers.

## Decision

We build `@micafox/sdk` and `@micafox/protocol` twice, as ES modules and as CommonJS, and the
`exports` map serves one for `import` and the other for `require()`.

## Alternatives

- **ES modules only, `engines` raised to `>=22.12`** — a single build, but apps on Node 22.0–22.11 cannot
  `require()` it, some releases print an `ExperimentalWarning` in the host app, and CommonJS TypeScript projects
  need TypeScript 5.8 or later to compile against it.
- **CommonJS only** — one build that loads everywhere, but while Node 22.0–22.11 is supported the SDK could never
  take a runtime dependency that ships only as an ES module, and the sources, tests and example, which are ES
  modules, would ship in a format they never run in.

## Consequences

- `import` and `require()` both work on every Node 22 release, without warnings.
- An app can load both builds, for example through two dependencies. The first copy stores the debugger on
  `globalThis` under `Symbol.for("micafox.debugger")` and every later copy exports it, so this costs memory but not
  correctness.
- The sources cannot use top-level `await`, because the CommonJS build cannot express it.
- Each package has two build outputs and two type entry points to keep correct. Until the first release both
  packages publish one ES module entry; the CommonJS build, the `import` and `require` conditions in `exports` and
  a test that loads each build are follow-up work.
