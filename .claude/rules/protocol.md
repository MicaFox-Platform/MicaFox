---
paths:
  - "packages/protocol/**"
---

# Protocol

`@micafox/protocol` is the public contract: the types and constants the SDK, custom connectors and the hub use,
including the messages they exchange (the protocol), and the public types end users need (`Connector`, `Breakpoint`,
`Snapshot`). Consumers are TypeScript and JavaScript only; the types are the full protocol spec.

- Only what both ends of the wire must agree on: messages, protocol constants, the `Connector` interface and the data
  types messages carry. Helpers and one package's internal types stay in that package, however many packages use
  them. See [ADR 0001](../../docs/adr/0001-keep-the-protocol-in-its-own-package.md).
- Types and constants only: no runtime logic, no side effects, no dependencies.
- Messages go over the wire as JSON: use values that survive `JSON.stringify` → `JSON.parse` unchanged. No `Date`,
  `Map`, `Set`, `bigint`, `undefined` values or class instances.
- The SDK, custom connectors and the hub may run different versions: every message carries the protocol
  version.
- Backward-compatible: add optional fields; never rename, remove or retype. A breaking change bumps the protocol
  version.
- Each protocol version's messages and data types live in `src/v<N>.ts` and fix `version` to the literal `<N>`, so a
  bump never retypes an older version. `src/index.ts` holds `PROTOCOL_VERSION`, `CLOSE_CODES` and `Connector`, which
  is typed by the current version's `Message`, and re-exports the current version's types.

```ts
// Bad
export interface Snapshot {
  capturedAt: Date;
  frames: Map<string, Frame>;
}

// Good (src/v1.ts)
export interface Snapshot {
  version: 1;
  capturedAt: string; // ISO 8601
  frames: Frame[];
  tags?: string[]; // added later, optional for old clients
}
```
