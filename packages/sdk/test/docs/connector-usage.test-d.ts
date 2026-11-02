// The Usage example of docs/api/sdk/connector.md, word for word below this comment: connector.test.ts fails
// when the two differ, and `pnpm typecheck` compiles it through the package's own exports.

import { PROTOCOL_VERSION } from "@probex-platform/protocol";
import { HubConnector } from "@probex-platform/sdk";

// url falls back to PROBEX_HUB_URL
const connector = new HubConnector({ batch: { flushIntervalMs: 250 } });

connector.onStatus((status) => {
  console.info("probex hub:", status);
});
connector.onMessage((message) => {
  console.info("from the hub:", message.type);
});

connector.connect();
// buffered until the hub accepts the session
connector.send({ version: PROTOCOL_VERSION, type: "breakpointStatus", breakpointId: "bp-1", status: "active" });

// the connector does not keep the process alive: your app's server or work does
process.once("SIGTERM", () => {
  void connector.close();
});
