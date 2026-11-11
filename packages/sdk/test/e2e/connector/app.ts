// A small host app for the connector E2E tests: creates a HubConnector from the MICAFOX_* environment variables and
// connects. It is started as a child process by run-app.ts, so the connector runs with a real event loop and exit.
//
// Each status change is written to stdout as `{"status":"<status>"}`. With `E2E_HOLD_UNTIL=<status>` the app keeps
// itself alive until that status is reported; otherwise nothing but the connector could keep it alive. Then it sends
// the messages of `E2E_SEND`, and with `E2E_CLOSE=1` calls close() right after. `E2E_CONNECTOR_OPTIONS` holds more
// HubConnector options as JSON.

import type { Message } from "@micafox/protocol";

import { HubConnector, type HubConnectorOptions } from "../../../src/connector/index.js";

// Written by run-app.ts from typed values
const options = JSON.parse(process.env.E2E_CONNECTOR_OPTIONS ?? "{}") as HubConnectorOptions;
const messages = JSON.parse(process.env.E2E_SEND ?? "[]") as Message[];
const holdUntil = process.env.E2E_HOLD_UNTIL;
const shouldClose = process.env.E2E_CLOSE === "1";
const hold = holdUntil === undefined ? undefined : setInterval(() => undefined, 60_000);

const connector = new HubConnector(options);
connector.onStatus((status) => {
  process.stdout.write(`${JSON.stringify({ status })}\n`);
  if (status !== holdUntil) {
    return;
  }

  for (const message of messages) {
    connector.send(message);
  }

  if (shouldClose) {
    void connector.close();
  }

  clearInterval(hold);
});
connector.connect();
