// The demo app: a Fastify server with a HubConnector beside it, configured by the MICAFOX_* environment variables.
// Until the debugger exists, debugger-stand-in.ts sends the replies it will send. Run it with the fake hub: README.md.

import { HubConnector } from "@micafox/sdk";
import Fastify, { type FastifyInstance } from "fastify";

import { createSampleSnapshot, toActiveStatuses } from "./debugger-stand-in.js";

const DEFAULT_PORT = 3000;
// A demo choice, not a recommendation: a restarted hub sees the app again within a second
const RECONNECT = { minDelayMs: 100, maxDelayMs: 1000 };

const readPort = (): number => {
  const port = process.env.PORT ?? "";
  return port === "" ? DEFAULT_PORT : Number(port);
};

const createConnector = (): HubConnector => {
  // url, token, service and labels come from MICAFOX_HUB_URL, MICAFOX_TOKEN, MICAFOX_SERVICE and MICAFOX_LABELS
  const connector = new HubConnector({ reconnect: RECONNECT });
  connector.onStatus((status) => {
    console.info(`connector status: ${status}`);
  });
  connector.onMessage((message) => {
    for (const status of toActiveStatuses(message)) {
      connector.send(status);
    }
  });
  return connector;
};

const createServer = (connector: HubConnector): FastifyInstance => {
  const server = Fastify();
  server.get("/health", () => ({ ok: true }));
  server.post("/demo/snapshot", async (_request, reply) => {
    connector.send(createSampleSnapshot(Date.now()));
    return await reply.code(202).send();
  });
  return server;
};

const shutDown = async (server: FastifyInstance, connector: HubConnector): Promise<void> => {
  try {
    // The server first, so no request sends a snapshot after the connector has closed
    await server.close();
  } catch (error) {
    console.error("server close failed:", error);
    process.exitCode = 1;
  }
  // close() never rejects; it sends what is buffered, then nothing keeps the process alive
  await connector.close();
  console.info("stopped");
};

const main = async (): Promise<void> => {
  const connector = createConnector();
  const server = createServer(connector);
  await server.listen({ host: "127.0.0.1", port: readPort() });
  console.info(`listening on port ${String(server.addresses()[0]?.port)}`);

  // Without a hub URL connect() would only log an error: the app runs on without a hub
  if ((process.env.MICAFOX_HUB_URL ?? "") === "") {
    console.info("MICAFOX_HUB_URL is not set: running without a hub");
  } else {
    connector.connect();
  }

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => void shutDown(server, connector));
  }
};

main().catch((error: unknown) => {
  console.error("failed to start:", error);
  process.exitCode = 1;
});
