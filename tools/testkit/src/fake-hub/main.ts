// A fake hub to try an app with and to test it end to end: it plays the hub side of docs/api/protocol.md#hello. It
// answers a hello with welcome and the breakpoints of HUB_BREAKPOINTS or HUB_BREAKPOINTS_FILE (breakpoints.ts), and
// prints every message it receives as one JSON line (connection.ts). Set HUB_TOKEN to accept only
// `Authorization: Bearer <HUB_TOKEN>`; PORT=0 picks a free port. It never prints headers or the token.
// Run it with `--conditions=@micafox/source --import tsx`.

import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { WebSocketServer } from "ws";

import { readBreakpoints } from "./breakpoints.js";
import { onConnection, print } from "./connection.js";

const DEFAULT_PORT = 8787;

const readPort = (): number => {
  const port = process.env.PORT ?? "";
  return port === "" ? DEFAULT_PORT : Number(port);
};

const isAuthorized = (request: IncomingMessage, token: string): boolean =>
  token === "" || request.headers.authorization === `Bearer ${token}`;

const rejectUpgrade = (socket: Socket): void => {
  socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  print("rejected upgrade: 401");
};

const main = (): void => {
  const token = process.env.HUB_TOKEN ?? "";
  const breakpoints = readBreakpoints(process.env);
  const server = createServer();
  const hub = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket: Socket, head) => {
    socket.on("error", () => {
      // The app closed the connection before the upgrade was answered
    });
    if (!isAuthorized(request, token)) {
      rejectUpgrade(socket);
      return;
    }

    hub.handleUpgrade(request, socket, head, (webSocket) => {
      onConnection(webSocket, breakpoints);
    });
  });
  server.on("error", (error) => {
    console.error("fake hub failed:", error.message);
    process.exitCode = 1;
  });
  server.listen(readPort(), "127.0.0.1", () => {
    // listen() with a port and a host always gives an AddressInfo
    print(`listening on port ${String((server.address() as AddressInfo).port)}`);
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      // close() would wait for the open connections, which the app keeps open
      for (const client of hub.clients) {
        client.terminate();
      }
      hub.close();
      server.close();
    });
  }
};

try {
  main();
} catch (error) {
  console.error("fake hub failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
