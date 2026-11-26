import { CLOSE_CODES } from "@micafox/protocol";
import type { Message } from "@micafox/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openEndpointApp, tokenOf } from "../../../../test/sdk-endpoint/endpoint-app.js";
import type { EndpointApp } from "../../../../test/sdk-endpoint/endpoint-app.js";
import { recordingModule } from "../../../../test/sdk-endpoint/recording-module.js";
import { helloOf, openSdk } from "../../../../test/sdk-endpoint/sdk-client.js";

const TOKEN = tokenOf("a");
const apps: EndpointApp[] = [];

afterEach(async () => {
  await Promise.all(
    apps.splice(0).map(async (app) => {
      await app.close();
    }),
  );
});

const statusOf = (breakpointId: string): Message => ({
  version: 1,
  module: "debugger",
  type: "breakpointStatus",
  breakpointId,
  status: "active",
});

// A welcomed client of the `debugger` module on an endpoint that serves it with a recording feature
const connect = async () => {
  const module = recordingModule("debugger");
  const app = await openEndpointApp({}, undefined, [module]);
  apps.push(app);
  const client = await openSdk(app.url, TOKEN);
  await client.hello(helloOf({ modules: ["debugger"] }));
  return { app, client, module };
};

describe("routing the frames of an SDK connection", () => {
  it("hands every message to its feature, in order, over frames and batches", async () => {
    const { client, module } = await connect();

    client.send(statusOf("b1.1"));
    client.send({ version: 1, type: "batch", messages: [statusOf("b2.1"), statusOf("b3.1")] });
    client.send(statusOf("b4.1"));
    await module.delivered(4);

    expect(module.received.map(({ message }) => message)).toEqual([
      statusOf("b1.1"),
      statusOf("b2.1"),
      statusOf("b3.1"),
      statusOf("b4.1"),
    ]);
  });

  it("keeps reading after a slow feature, so no frame is lost", async () => {
    const module = recordingModule("debugger", {
      onMessage: async () => {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      },
    });
    const app = await openEndpointApp({}, undefined, [module]);
    apps.push(app);
    const client = await openSdk(app.url, TOKEN);
    await client.hello(helloOf({ modules: ["debugger"] }));

    for (let index = 0; index < 50; index += 1) {
      client.send(statusOf(`b${String(index)}.1`));
    }
    await module.delivered(50);

    expect(module.received.map(({ message }) => (message as { breakpointId: string }).breakpointId)).toEqual(
      Array.from({ length: 50 }, (_, index) => `b${String(index)}.1`),
    );
  });

  it("closes with protocolError on a frame that is not a message", async () => {
    const { client } = await connect();

    client.sendRaw("[1, 2");

    expect(await client.closed).toEqual({ code: CLOSE_CODES.protocolError });
  });

  it("closes with protocolError on a message of another version", async () => {
    const { client } = await connect();

    client.send({ ...statusOf("b1.1"), version: 2 });

    expect(await client.closed).toEqual({ code: CLOSE_CODES.protocolError });
  });

  it("drops what exceeds the rate and keeps the session", async () => {
    const module = recordingModule("debugger");
    const app = await openEndpointApp({ sdkMaxMessagesPerSecond: 1 }, undefined, [module]);
    apps.push(app);
    const client = await openSdk(app.url, TOKEN);
    await client.hello(helloOf({ modules: ["debugger"] }));
    const messages = Array.from({ length: 12 }, (_, index) => statusOf(`b${String(index)}.1`));

    client.send({ version: 1, type: "batch", messages });
    // The rest of the batch is dropped after the tenth message, with no signal but the count
    await vi.waitFor(() => {
      expect(app.endpoint.counts()).toEqual([{ name: "rate-limited", count: 2 }]);
    });
    app.manual.advance(1000);
    client.send(statusOf("later.1"));
    await module.delivered(11);

    expect(module.received.at(-1)?.message).toEqual(statusOf("later.1"));
  });
});
