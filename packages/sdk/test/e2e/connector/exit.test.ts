import { describe, expect, it } from "vitest";

import { E2E_TEST_TIMEOUT_MS, runApp } from "./run-app.js";
import { findClosedPort, useFakeHubs, type FakeHub } from "../../connector/fake-hub.js";

// Answers the hello with a frame other than welcome, then stops reading, so the connector's close frame gets no
// answer and only the connector's close timeout ends the socket
const sendWrongFrameAndStopReading = async (hub: FakeHub): Promise<void> => {
  const connection = await hub.nextConnection();
  await connection.nextFrame();
  connection.socket.send('{"version":1,"module":"debugger","type":"breakpoints","breakpoints":[]}');
  connection.socket.pause();
};

const welcomeNextConnection = async (hub: FakeHub): Promise<void> => {
  const connection = await hub.nextConnection();
  await connection.nextFrame();
  connection.sendWelcome();
};

describe("connector process exit", { timeout: E2E_TEST_TIMEOUT_MS }, () => {
  const hubs = useFakeHubs();

  it("lets the app exit by itself when the hub refuses connections", async () => {
    const port = await findClosedPort();

    const run = await runApp({ hubUrl: `ws://127.0.0.1:${String(port)}/micafox` });

    expect({ exitCode: run.exitCode, statuses: run.statuses }).toEqual({
      exitCode: 0,
      statuses: ["connecting", "disconnected"],
    });
  });

  it("lets the app exit by itself while it waits for a welcome that never comes", async () => {
    const hub = await hubs.start();

    const run = await runApp({ hubUrl: hub.url });

    expect({ exitCode: run.exitCode, statuses: run.statuses }).toEqual({ exitCode: 0, statuses: ["connecting"] });
  });

  it("lets the app exit by itself while connected, with pings scheduled", async () => {
    const hub = await hubs.start();
    const welcomed = welcomeNextConnection(hub);

    // Held until connected; after that only the open socket and the ping timer could hold the app
    const run = await runApp({ hubUrl: hub.url, holdUntil: "connected" });
    await welcomed;

    expect({ exitCode: run.exitCode, statuses: run.statuses }).toEqual({
      exitCode: 0,
      statuses: ["connecting", "connected"],
    });
  });

  it("lets the app exit by itself after a protocol error when the hub never answers the close", async () => {
    const hub = await hubs.start();
    const misbehaved = sendWrongFrameAndStopReading(hub);

    // Held until disconnected, so the hub's frame arrives; after that only the closing socket can hold the app
    const run = await runApp({ hubUrl: hub.url, holdUntil: "disconnected" });
    await misbehaved;

    expect({ exitCode: run.exitCode, statuses: run.statuses }).toEqual({
      exitCode: 0,
      statuses: ["connecting", "disconnected"],
    });
  });
});
