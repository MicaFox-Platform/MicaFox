# node-basic

A demo app for the ProbeX SDK: a Fastify server with a `HubConnector` beside it, configured by the `PROBEX_*`
environment variables. Until the debugger exists, the app stands in for it: it reports every breakpoint the hub sends
as `active`, and `POST /demo/snapshot` sends a sample snapshot.

A fake hub in `src/hub/fake-hub.ts` plays the hub, so you can watch the connector work without one.

## Run it locally

From the repository root, after `pnpm install`, start the fake hub in one terminal:

```sh
pnpm --filter @probex-platform/node-basic dev:hub
# listening on port 8787
```

Then the app in another:

```sh
PROBEX_HUB_URL=ws://127.0.0.1:8787/probex PROBEX_SERVICE=demo PROBEX_LABELS=team=demo \
  pnpm --filter @probex-platform/node-basic dev
# listening on port 3000
# connector status: connecting
# connector status: connected
```

The hub prints every message it receives as one JSON line: the `hello`, then a `breakpointStatus` per breakpoint.
Send a snapshot and watch it arrive:

```sh
curl -X POST http://127.0.0.1:3000/demo/snapshot
```

Stop the hub and the app keeps serving HTTP; start it again and the app reconnects within a second. `Ctrl+C` stops
the app: it sends what is still buffered, then exits.

## Configuration

App:

| Variable         | Meaning                                                     |
| ---------------- | ----------------------------------------------------------- |
| `PORT`           | HTTP port, default `3000`; `0` picks a free one             |
| `PROBEX_HUB_URL` | the hub's WebSocket URL; unset → the app runs without a hub |
| `PROBEX_TOKEN`   | sent as `Authorization: Bearer <token>`                     |
| `PROBEX_SERVICE` | service name in the `hello`                                 |
| `PROBEX_LABELS`  | labels in the `hello`, such as `team=payments,region=eu`    |

All `PROBEX_*` variables: [SDK API](../../docs/api/sdk/connector.md#hubconnector). The app always uses a reconnect
delay of 100 ms to 1 s, a demo choice that lets a restarted hub see it again quickly.

Fake hub:

| Variable          | Meaning                                                                   |
| ----------------- | ------------------------------------------------------------------------- |
| `PORT`            | port, default `8787`; `0` picks a free one and prints it                  |
| `HUB_TOKEN`       | when set, an upgrade without `Authorization: Bearer <HUB_TOKEN>` gets 401 |
| `HUB_BREAKPOINTS` | JSON array of breakpoints sent after `welcome`; unset → two sample ones   |

## Tests

`tests/` starts the fake hub and the app as real processes and checks the connector's main flows: the handshake,
snapshots, a hub restart, a rejected token and shutdown. They run in `pnpm verify`, or alone with
`pnpm --filter @probex-platform/node-basic test`.
