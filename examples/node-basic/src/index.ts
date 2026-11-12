// The demo app: a Fastify server debugged by MicaFox, configured by the MICAFOX_* environment variables. Run it with
// the fake hub: README.md.

import { micafox } from "@micafox/sdk";
import Fastify, { type FastifyInstance } from "fastify";

import { quote } from "./pricing.js";
import { registerValueRoutes } from "./values.js";

const DEFAULT_PORT = 3000;
// A demo choice, not a recommendation: a restarted hub sees the app again within a second
const RECONNECT = { minDelayMs: 100, maxDelayMs: 1000 };

const PRICE_QUERY = {
  type: "object",
  properties: {
    sku: { type: "string", default: "SKU-1" },
    quantity: { type: "integer", minimum: 1, default: 1 },
  },
} as const;

interface PriceQuery {
  sku: string;
  quantity: number;
}

const readPort = (): number => {
  const port = process.env.PORT ?? "";
  return port === "" ? DEFAULT_PORT : Number(port);
};

const createServer = (): FastifyInstance => {
  const server = Fastify({ logger: true });
  server.get("/health", () => ({ ok: true }));
  server.get("/price", { schema: { querystring: PRICE_QUERY } }, (request) => {
    // Safe: Fastify has validated the query against PRICE_QUERY, coerced `quantity` and filled in the defaults
    const { sku, quantity } = request.query as PriceQuery;
    return quote(sku, quantity);
  });
  registerValueRoutes(server);
  return server;
};

const shutDown = async (server: FastifyInstance): Promise<void> => {
  try {
    // The server first, so no request is captured after the debugger has stopped
    await server.close();
  } catch (error) {
    server.log.error(error, "server close failed");
    process.exitCode = 1;
  }
  // stop() never rejects; it sends the buffered snapshots, then nothing keeps the process alive
  await micafox.stop();
  server.log.info("stopped");
};

const main = async (): Promise<void> => {
  const server = createServer();
  // The SDK logs through the app's own pino; url, token, service and labels come from MICAFOX_* variables
  micafox.configure({ logger: server.log, hubConnector: { reconnect: RECONNECT } });
  // Before listen(), so the hub's breakpoints can be set before the first request
  micafox.run();
  // A failed listen() needs no stop(): the debugger never keeps the process alive by itself
  await server.listen({ host: "127.0.0.1", port: readPort() });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => void shutDown(server));
  }
};

main().catch((error: unknown) => {
  console.error("failed to start:", error);
  process.exitCode = 1;
});
