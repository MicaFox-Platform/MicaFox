// The HubConnector example of docs/api/sdk/connector.md, word for word below this comment: connector.test.ts
// fails when the two differ, and `pnpm typecheck` compiles it through the package's own exports.

import { HubConnector } from "@micafox/sdk";

const connector = new HubConnector({
  url: "wss://hub.example.com/micafox",
  service: "checkout",
  labels: { region: "eu" },
});
connector.connect(); // token from MICAFOX_TOKEN
