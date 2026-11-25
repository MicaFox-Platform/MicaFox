import { PROTOCOL_VERSION } from "@micafox/protocol";
import type { Hello, Welcome } from "@micafox/protocol";
import { WebSocket } from "ws";

/** A `hello` as the SDK sends it, with `overrides`. */
export const helloOf = (overrides: Partial<Hello> = {}): Hello => ({
  version: PROTOCOL_VERSION,
  type: "hello",
  instanceId: "8f14e45f-ceea-467f-a0e6-3b5c2a1d9e7b",
  service: "checkout",
  labels: { region: "eu" },
  hostname: "checkout-7d9f",
  pid: 1,
  sdk: { name: "@micafox/sdk", version: "0.1.0" },
  runtime: { name: "node", version: process.versions.node },
  modules: ["debugger"],
  ...overrides,
});

/** How a connection ended. */
export interface Closed {
  code: number;
}

/** An SDK connection that the hub upgraded, speaking the protocol as a connector does. */
export interface SdkClient {
  socket: WebSocket;
  /** Every text frame the hub sent, parsed. */
  received: unknown[];
  /** Settles with the hub's first message. */
  firstMessage: Promise<unknown>;
  closed: Promise<Closed>;
  send: (message: unknown) => void;
  /** Sends `hello` and settles with the hub's answer. */
  hello: (hello?: Hello) => Promise<Welcome>;
}

/** What the hub answered instead of the upgrade. */
export interface Refused {
  status: number;
  contentType: string | undefined;
  body: Record<string, unknown>;
}

const readBody = async (response: import("node:http").IncomingMessage): Promise<string> =>
  await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("end", () => {
      resolve(Buffer.concat(chunks).toString());
    });
    response.on("error", reject);
  });

const clientOf = (socket: WebSocket): SdkClient => {
  const received: unknown[] = [];
  const firstMessage = new Promise<unknown>((resolve) => {
    socket.on("message", (data: Buffer) => {
      const message: unknown = JSON.parse(data.toString());
      received.push(message);
      resolve(message);
    });
  });
  const closed = new Promise<Closed>((resolve) => {
    socket.on("close", (code) => {
      resolve({ code });
    });
  });
  const send = (message: unknown): void => {
    socket.send(JSON.stringify(message));
  };
  return {
    socket,
    received,
    firstMessage,
    closed,
    send,
    hello: async (hello = helloOf()) => {
      send(hello);
      // The test asserts the shape of what the hub answered
      return (await firstMessage) as Welcome;
    },
  };
};

/** Opens `GET /sdk` on the hub at `url` with `token` as the bearer, as the SDK's connector does. */
export const connectSdk = async (
  url: string,
  options: { token?: string; path?: string } = {},
): Promise<SdkClient | Refused> => {
  const headers: Record<string, string> =
    options.token === undefined ? {} : { authorization: `Bearer ${options.token}` };
  const socket = new WebSocket(`${url.replace(/^http/, "ws")}${options.path ?? "/sdk"}`, { headers });
  return await new Promise((resolve, reject) => {
    socket.once("open", () => {
      resolve(clientOf(socket));
    });
    socket.once("unexpected-response", (_request, response) => {
      void readBody(response).then((text) => {
        resolve({
          status: response.statusCode ?? 0,
          contentType: response.headers["content-type"],
          body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
        });
      }, reject);
    });
    socket.once("error", reject);
  });
};

/** Opens `GET /sdk` and fails the test unless the hub upgrades it. */
export const openSdk = async (url: string, token: string): Promise<SdkClient> => {
  const result = await connectSdk(url, { token });
  if ("status" in result) {
    throw new Error(`The hub refused the upgrade with ${String(result.status)}`);
  }
  return result;
};
