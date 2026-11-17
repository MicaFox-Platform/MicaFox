# Architecture decisions

Why MicaFox works the way it does: one ADR per choice that is costly to reverse, in the folder of the component it
belongs to, the same as in [architecture](../architecture/overview.md). Numbers are global and never reused. A
superseded ADR keeps its number, gets the `superseded_` prefix and moves to [Superseded](#superseded). Rules for
writing one: [`.claude/rules/adr.md`](../../.claude/rules/adr.md).

## Packages

`packages/` — Package boundaries and how they are published.

- [0001. Keep the protocol in its own package](packages/0001-keep-the-protocol-in-its-own-package.md)
- [0013. Publish the packages as ES modules and CommonJS](packages/0013-publish-the-packages-as-es-modules-and-commonjs.md)
- [0021. Version and publish the packages with Changesets](packages/0021-version-and-publish-the-packages-with-changesets.md)

## Protocol

`protocol/` — Messages, the `Connector` interface and the guarantees between the SDK and a hub.

- [0004. Use handler functions in the Connector interface](protocol/0004-use-handler-functions-in-the-connector-interface.md)
- [0007. Deliver messages to the hub at most once](protocol/0007-deliver-messages-to-the-hub-at-most-once.md)
- [0008. Use WebSocket for the hub connection](protocol/0008-use-websocket-for-the-hub-connection.md)
- [0010. Send the full breakpoint set on every change](protocol/0010-send-the-full-breakpoint-set-on-every-change.md)
- [0011. Encode snapshot values as a nested tree](protocol/0011-encode-snapshot-values-as-a-nested-tree.md)
- [0016. Use the hello's protocol version for the session](protocol/0016-use-the-hellos-protocol-version-for-the-session.md)
- [0017. Tag messages with their module and agree on modules](protocol/0017-tag-messages-with-their-module-and-agree-on-modules.md)
- [0019. Report the deployed commit in hello](protocol/0019-report-the-deployed-commit-in-hello.md)

## SDK

`sdk/` — The SDK as a whole: what ships in it and how it is configured.

- [0002. Ship the default connector inside the SDK](sdk/0002-ship-the-default-connector-inside-the-sdk.md)
- [0003. Configure the SDK from options, then env](sdk/0003-configure-the-sdk-from-options-then-env.md)

## SDK: connector

`sdk/connector/` — The default hub connector.

- [0005. Batch and rate-limit messages in the connector](sdk/connector/0005-batch-and-rate-limit-messages-in-the-connector.md)
- [0006. Authenticate to the hub with a bearer token](sdk/connector/0006-authenticate-to-the-hub-with-a-bearer-token.md)
- [0009. Run the hub handshake in the connector](sdk/connector/0009-run-the-hub-handshake-in-the-connector.md)

## SDK: debugger

`sdk/debugger/` — Breakpoints and snapshots.

- [0012. Redact secrets by name inside the SDK](sdk/debugger/0012-redact-secrets-by-name-inside-the-sdk.md)
- [0018. Expire breakpoints in the SDK by a time left from the hub](sdk/debugger/0018-expire-breakpoints-in-the-sdk-by-a-time-left-from-the-hub.md)
- [0020. Find a bundle by reading maps on demand](sdk/debugger/0020-find-a-bundle-by-reading-maps-on-demand.md)

## SDK: logger

`sdk/logger/` — The SDK's own log lines.

- [0014. Pass SDK logs as a full message and a context](sdk/logger/0014-pass-sdk-logs-as-a-full-message-and-a-context.md)
- [0015. Filter SDK logs by level before the app's logger](sdk/logger/0015-filter-sdk-logs-by-level-before-the-apps-logger.md)

## Superseded

None yet.
