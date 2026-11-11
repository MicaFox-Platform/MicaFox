import type { Message } from "@micafox/protocol";
import { describe, expect, it } from "vitest";

import { E2E_TEST_TIMEOUT_MS, runApp } from "./run-app.js";
import { useFakeHubs, type FakeHub, type HubConnection } from "../../connector/fake-hub.js";

const status = (breakpointId: string): Message => ({
  version: 1,
  type: "breakpointStatus",
  breakpointId,
  status: "active",
});

// Welcomes the first connection and hands it over, so the test can read what it received
const welcomeFirst = async (hub: FakeHub): Promise<HubConnection> => {
  const connection = await hub.nextConnection();
  await connection.nextFrame();
  connection.sendWelcome();
  return connection;
};

describe("connector sending in a real process", { timeout: E2E_TEST_TIMEOUT_MS }, () => {
  const hubs = useFakeHubs();

  it("lets the app exit by itself while a message waits for its batch", async () => {
    const hub = await hubs.start();
    const welcomed = welcomeFirst(hub);

    const run = await runApp({
      hubUrl: hub.url,
      holdUntil: "connected",
      send: [status("bp-1")],
      connectorOptions: { batch: { flushIntervalMs: 60_000 } },
    });
    await welcomed;

    expect(run).toEqual({ exitCode: 0, statuses: ["connecting", "connected"], stderr: [] });
  });

  it("keeps the app alive after close() until queued messages reach the hub, then lets it exit", async () => {
    const hub = await hubs.start();
    const welcomed = welcomeFirst(hub);

    // The second status waits about 0.8 s for the rate limit on an unref'd timer: only close() holds the app
    const run = await runApp({
      hubUrl: hub.url,
      holdUntil: "connected",
      send: [status("bp-1"), status("bp-2")],
      shouldClose: true,
      connectorOptions: { batch: { maxMessages: 1 }, rateLimit: { bytesPerSecond: 100 } },
    });
    const connection = await welcomed;
    const closeCode = await connection.closed;

    expect({
      exitCode: run.exitCode,
      statuses: run.statuses,
      closeCode,
      received: connection.frames.slice(1).map((frame) => JSON.parse(frame) as unknown),
    }).toEqual({
      exitCode: 0,
      statuses: ["connecting", "connected", "closed"],
      closeCode: 1000,
      received: [status("bp-1"), status("bp-2")],
    });
  });

  it("lets the app exit by itself after close() when the hub stops reading", async () => {
    const hub = await hubs.start();
    const stalled = welcomeFirst(hub).then((connection) => {
      connection.socket.pause();
    });

    // The flush outlasts closeTimeoutMs and the hub never answers the close: only close()'s own limits end it
    const run = await runApp({
      hubUrl: hub.url,
      holdUntil: "connected",
      send: [status("bp-1"), status("bp-2"), status("bp-3")],
      shouldClose: true,
      connectorOptions: { batch: { maxMessages: 1 }, rateLimit: { bytesPerSecond: 100 }, closeTimeoutMs: 1000 },
    });
    await stalled;

    expect({ exitCode: run.exitCode, statuses: run.statuses }).toEqual({
      exitCode: 0,
      statuses: ["connecting", "connected", "closed"],
    });
  });

  it("lets the app exit by itself while a message waits for the rate limit", async () => {
    const hub = await hubs.start();
    const welcomed = welcomeFirst(hub);

    // One byte per second: the first status goes at once and leaves the bucket in debt for about a minute
    const run = await runApp({
      hubUrl: hub.url,
      holdUntil: "connected",
      send: [status("bp-1"), status("bp-2")],
      connectorOptions: { batch: { maxMessages: 1 }, rateLimit: { bytesPerSecond: 1 } },
    });
    const connection = await welcomed;
    // TCP delivers what the app wrote before the close
    await connection.closed;

    expect({
      exitCode: run.exitCode,
      received: connection.frames.slice(1).map((frame) => JSON.parse(frame) as unknown),
    }).toEqual({ exitCode: 0, received: [status("bp-1")] });
  });
});
