// The configure example of docs/api/sdk/debugger.md, word for word below this comment: debugger.test.ts fails when
// the two differ, and `pnpm typecheck` compiles it through the package's own exports.

import { micafox } from "@micafox/sdk";

micafox.configure({
  service: "checkout",
  labels: { region: "eu" },
  redact: ["iban", "ssn"],
  hubConnector: { batch: { flushIntervalMs: 250 } },
});
