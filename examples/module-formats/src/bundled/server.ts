// TypeScript bundled by esbuild, with the SDK, into one CommonJS file and its .map. Bundled output is not supported:
// tests/bundled.test.ts records what it reports. It serves `GET /quote` on PORT and is debugged by `micafox`,
// configured by the MICAFOX_* environment variables.

import { micafox } from "@micafox/sdk";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { quote } from "./quote.js";

// A test choice, not a recommendation: a restarted hub sees the app again within a second
const RECONNECT = { minDelayMs: 100, maxDelayMs: 1000 };

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname !== "/quote") {
    response.writeHead(404).end();
    return;
  }

  const body = quote(url.searchParams.get("sku") ?? "SKU-1", Number(url.searchParams.get("quantity") ?? "1"));
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
});

micafox.configure({ hubConnector: { reconnect: RECONNECT } });
// Before listen(), so the hub's breakpoints can be set before the first request
micafox.run();
server.listen(Number(process.env.PORT ?? "0"), "127.0.0.1", () => {
  // listen() with a port and a host always gives an AddressInfo
  console.log(`listening on port ${String((server.address() as AddressInfo).port)}`);
});

process.once("SIGTERM", () => {
  // The server first, so no request is captured after the debugger has stopped; stop() sends the buffered snapshots
  server.close(() => void micafox.stop());
});
