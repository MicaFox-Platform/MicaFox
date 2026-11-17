import { describe, expect, it } from "vitest";

import { E2E_TEST_TIMEOUT_MS, runApp } from "./run-app.js";
import { CERT_FILE, useFakeHubs, type FakeHub } from "../../connector/fake-hub.js";

// Answers every hello with a welcome
const welcomeEveryone = async (hub: FakeHub): Promise<void> => {
  const connection = await hub.nextConnection();
  await connection.nextFrame();
  connection.sendWelcome();
};

describe("connector TLS in a real process", { timeout: E2E_TEST_TIMEOUT_MS }, () => {
  const hubs = useFakeHubs();

  it.each(["localhost", "127.0.0.1"])(
    "connects to wss://%s with a CA from NODE_EXTRA_CA_CERTS and writes nothing to stderr",
    async (host) => {
      const hub = await hubs.start({ isSecure: true });
      const welcomed = welcomeEveryone(hub);

      const run = await runApp({
        hubUrl: `wss://${host}:${String(hub.port)}/micafox`,
        extraCaCerts: CERT_FILE,
        holdUntil: "connected",
      });
      await welcomed;

      expect(run).toEqual({ exitCode: 0, statuses: ["connecting", "connected"], stderr: [] });
    },
  );
});
