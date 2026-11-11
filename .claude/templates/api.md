<!--
API doc template, used by /architect and /task.
Copy to `docs/api/<package>.md` or `docs/api/<package>/<part>.md` and remove this comment. Rules:
`.claude/rules/docs.md`.
-->

# @micafox/package API

## Installation

```sh
pnpm add @micafox/package
```

## Exports

### `exportName()`

```ts
function exportName(options: ExportNameOptions): Result;
```

One sentence: what it does and when to use it.

**Parameters**

- `options.field` — `string`, required. What it means; default and allowed values.

**Returns** `Result` — what the caller gets.

**Errors** — what fails and how it is reported. Never throws into the host app: say what happens instead.

```ts
import { exportName } from "@micafox/package";

exportName({ field: "value" });
```

### `oldName()`

Renamed to [`exportName()`](#exportname). Removed in the next major version.

## Usage

The common case end to end: set up, use, shut down. Link each export above instead of re-explaining it.

```ts
import { exportName } from "@micafox/package";

exportName({ field: "value" });
```
