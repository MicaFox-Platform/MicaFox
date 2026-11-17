# 0017. Tag messages with their module and agree on modules

## Status

Accepted · 2026-11-11

## Context

The SDK is a set of modules over one connector: the debugger first, error tracking and logpoints later, each
adoptable on its own. All of them share one `PROTOCOL_VERSION` and ship in `@micafox/sdk`. Every peer, including
custom connectors and custom hubs, has to tell which module a message belongs to, and modules should be free to use
the same message names. An app should not spend CPU and traffic on a module the hub cannot use, such as a hub that
has no error tracking. Older SDKs keep running against newer hubs, so a peer must be able to skip what it does not
know. The protocol is not published yet, so version 1 can still change.

## Decision

We put a required `module` on every message of a module, keep the session frames `hello`, `welcome` and `batch`
without one, and agree on modules in the handshake: `hello.modules` lists what the SDK runs, `welcome.modules` what
the hub accepts, and only accepted modules exchange messages in that session.

## Alternatives

- **Optional `module`, a missing one meaning `debugger`** — only useful to stay compatible with peers that do not
  exist yet; it leaves two spellings of every debugger message, and every hub and connector implements the default
  forever.
- **The module in the type name, such as `debugger.breakpoints`** — every peer parses names by convention to route
  a message, and nothing separates a module from a message type in the types.
- **A `module` field without `welcome.modules`** — a module the hub cannot use, such as error tracking against a
  hub without it, would keep capturing and sending data that the hub drops.

## Consequences

- A frame is routed by its `type` when it is `hello`, `welcome` or `batch`, which no module may use, and by
  `module` and `type` otherwise. Type names are unique within a module only.
- A peer ignores messages of a module it does not know or did not agree on, so adding a module, or a message type
  to one, is a compatible change to version 1.
- The connector filters outgoing messages against the latest `welcome` and logs one warning per session for each
  module the hub did not accept. Connectors learn the module list from the SDK, not from the app.
- The full breakpoint list after every `welcome`
  ([ADR 0007](0007-deliver-messages-to-the-hub-at-most-once.md),
  [ADR 0010](0010-send-the-full-breakpoint-set-on-every-change.md)) applies to sessions where both lists hold
  `debugger`.
- Every module message carries one more short field.
