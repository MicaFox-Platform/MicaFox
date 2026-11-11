import { describe, expect, it } from "vitest";

import { useFakeHubs } from "../../../test/connector/fake-hub.js";
import { parseFrame } from "../../../test/connector/harness.js";
import { createDebugger } from "../../../test/debugger/fakes.js";

const hubs = useFakeHubs();

// The real HubConnector against a fake hub: what the fake connector of debugger-hub.test.ts cannot show
describe("Debugger with the real HubConnector", () => {
  it("connects to the hub with its service and token and shares its logger with the connector", async () => {
    const hub = await hubs.start();
    const { micafox, lines } = createDebugger();
    micafox.configure({ url: hub.url, token: "token-1", service: "checkout", logLevel: "debug" });

    micafox.run();
    const connection = await hub.nextConnection();
    const hello = parseFrame(await connection.nextFrame());
    connection.sendWelcome();
    await micafox.stop();

    expect({
      authorization: connection.request.headers.authorization,
      service: hello.service,
      connectorLines: lines.some((line) => line.message.startsWith("[micafox] connector: ")),
    }).toEqual({ authorization: "Bearer token-1", service: "checkout", connectorLines: true });
  });

  it("closes the hub connection with code 1000 when stop() resolves", async () => {
    const hub = await hubs.start();
    const { micafox } = createDebugger();
    // The connector logs "connected" through the debugger's logger, which is how the test knows the welcome arrived
    const connected = Promise.withResolvers<undefined>();
    const write = (message: string): void => {
      if (message.includes("connected to the hub")) {
        connected.resolve(undefined);
      }
    };
    micafox.configure({
      url: hub.url,
      logLevel: "info",
      logger: { debug: write, info: write, warn: write, error: write },
    });
    micafox.run();
    const connection = await hub.nextConnection();
    await connection.nextFrame();
    connection.sendWelcome();
    await connected.promise;

    await micafox.stop();

    expect(await connection.closed).toBe(1000);
  });
});
