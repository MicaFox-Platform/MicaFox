import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useFakeHubs, type FakeHub, type UpgradeReply } from "../../../test/connector/fake-hub.js";
import {
  advanceToReconnect,
  createHarness,
  useConnectorFakeTimers,
  type Harness,
} from "../../../test/connector/harness.js";

// Each secret is unique, so a leak shows which one escaped
const TOKEN = "token-SECRET-1";
const PASSWORD = "password-SECRET-2";
const QUERY = "query-SECRET-3";
const FRAGMENT = "fragment-SECRET-4";
const SECRET = /SECRET/;

describe("HubConnector TLS", () => {
  const hubs = useFakeHubs();

  beforeEach(() => {
    useConnectorFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  const connectToSelfSigned = async (hub: FakeHub): Promise<Harness> => {
    const harness = createHarness(hubs, { url: hub.url, reconnect: { minDelayMs: 1000, maxDelayMs: 8000 } });
    const disconnected = harness.nextStatus("disconnected");
    harness.connector.connect();
    await disconnected;
    return harness;
  };

  it("logs a warning and reconnects when the hub's certificate is self-signed", async () => {
    const hub = await hubs.start({ isSecure: true });
    const harness = await connectToSelfSigned(hub);
    const connecting = harness.nextStatus("connecting");

    await advanceToReconnect(harness);
    await connecting;

    expect({ warnings: harness.messagesAt("warn"), requests: hub.requests.length }).toEqual({
      warnings: [`could not connect to the hub at ${hub.url} (DEPTH_ZERO_SELF_SIGNED_CERT)`],
      requests: 0,
    });
  });

  it("verifies the certificate even when NODE_TLS_REJECT_UNAUTHORIZED is 0", async () => {
    vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    const hub = await hubs.start({ isSecure: true });

    const harness = await connectToSelfSigned(hub);

    expect(harness.messagesAt("warn")).toEqual([
      `could not connect to the hub at ${hub.url} (DEPTH_ZERO_SELF_SIGNED_CERT)`,
    ]);
  });
});

describe("HubConnector logs", () => {
  const hubs = useFakeHubs();

  // A URL whose userinfo, query and fragment all carry secrets
  const secretUrl = (hub: FakeHub): string =>
    `${hub.url.replace("ws://", `ws://user:${PASSWORD}@`)}?key=${QUERY}#${FRAGMENT}`;

  // Connects with every secret set and waits until the attempt has failed
  const failWith = async (hub: FakeHub, reply: UpgradeReply): Promise<Harness> => {
    hub.reply = reply;
    const harness = createHarness(hubs, { url: secretUrl(hub), token: TOKEN });
    const disconnected = harness.nextStatus("disconnected");
    harness.connector.connect();
    await disconnected;
    return harness;
  };

  it("sends the query to the hub but neither the userinfo nor the fragment", async () => {
    const hub = await hubs.start();
    const harness = createHarness(hubs, { url: secretUrl(hub), token: TOKEN });

    harness.connector.connect();
    const request = await hub.nextRequest();

    expect({ url: request.url, authorization: request.headers.authorization }).toEqual({
      url: `/probex?key=${QUERY}`,
      authorization: `Bearer ${TOKEN}`,
    });
  });

  it.each<{ name: string; reply: UpgradeReply }>([
    {
      name: "a redirect to a URL with the secrets",
      reply: { kind: "status", status: 307, headers: { location: `wss://hub.example.com/?t=${TOKEN}&q=${QUERY}` } },
    },
    {
      name: "a 401 with a challenge header",
      reply: { kind: "status", status: 401, headers: { "WWW-Authenticate": `Bearer realm="${TOKEN}"` } },
    },
    {
      name: "an upgrade the connector aborts",
      reply: {
        kind: "acceptWithHeaders",
        headers: { "Sec-WebSocket-Extensions": "permessage-deflate", "X-Echo": TOKEN },
      },
    },
  ])("logs none of the secrets after $name", async ({ reply }) => {
    const hub = await hubs.start();

    const harness = await failWith(hub, reply);

    expect(JSON.stringify(harness.lines)).not.toMatch(SECRET);
  });

  it("logs neither the secrets nor the close reason when the hub closes", async () => {
    const hub = await hubs.start();
    const harness = createHarness(hubs, { url: secretUrl(hub), token: TOKEN });
    const disconnected = harness.nextStatus("disconnected");
    harness.connector.connect();
    const connection = await hub.nextConnection();
    await connection.nextFrame();

    connection.socket.close(4000, `reason-SECRET-5 ${TOKEN}`);
    await disconnected;

    expect({
      leaked: JSON.stringify(harness.lines).includes("SECRET"),
      warnings: harness.messagesAt("warn"),
    }).toEqual({ leaked: false, warnings: ["the connection to the hub closed (close code 4000)"] });
  });

  it("logs no secret in the URL check's error", () => {
    const harness = createHarness(hubs, { url: `ws://user:${PASSWORD}@hub.example.com/?key=${QUERY}`, token: TOKEN });

    harness.connector.connect();

    expect({ leaked: JSON.stringify(harness.lines).includes("SECRET"), errors: harness.messagesAt("error") }).toEqual({
      leaked: false,
      errors: ["a token is sent over ws:// only to localhost, 127.0.0.0/8 or [::1]; use wss://"],
    });
  });
});
