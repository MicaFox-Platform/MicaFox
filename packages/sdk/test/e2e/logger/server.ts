// A small host app for the logger E2E tests: an HTTP server whose routes drive the SDK's logger. It is started as a
// child process by run-server.ts, so the logger runs with a real environment, console, event loop and process exit.
//
// Configured by environment variables:
// - `E2E_LOGGER` — the app logger passed as `logger` (see app-loggers.ts); unset passes none.
// - `E2E_LOG_LEVEL` — passed as `logLevel`; unset passes none.
// - `MICAFOX_LOG_LEVEL` — read by the SDK itself.
//
// Routes, each answered with 204 and marked in stdout as `{"step":"<route>"}`:
// - `/log?level=&message=&key=&breakpointId=&errorCode=` — logs one line.
// - `/hold`, `/release`, `/flush` — call the logger's method of that name.
// - `/close` — stops the server without `process.exit()`, so the process exits only when nothing keeps it alive.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { findAppLogger } from "./app-loggers.js";
import { createLogger, type SdkLogger } from "../../../src/logger/index.js";

const COMPONENT = "e2e";
const LINE_LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);

type LineLevel = Parameters<SdkLogger["log"]>[0];

// Marks a request in stdout, so a test can see where held lines land relative to the requests
const writeStep = (step: string): void => {
  process.stdout.write(`${JSON.stringify({ step })}\n`);
};

class E2eError extends Error {
  override readonly name = "E2eError";

  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

const isLineLevel = (value: string | null): value is LineLevel => value !== null && LINE_LEVELS.has(value);

const optional = (value: string | null): string | undefined => value ?? undefined;

const logLine = (logger: SdkLogger, params: URLSearchParams): boolean => {
  const level = params.get("level");
  if (!isLineLevel(level)) {
    return false;
  }

  const key = optional(params.get("key"));
  const breakpointId = optional(params.get("breakpointId"));
  const errorCode = params.get("errorCode");
  logger.log(level, params.get("message") ?? "", {
    component: COMPONENT,
    ...(key === undefined ? {} : { key }),
    ...(breakpointId === undefined ? {} : { breakpointId }),
    ...(errorCode === null ? {} : { error: new E2eError("request failed", errorCode) }),
  });
  return true;
};

// Returns whether the route exists and its input was valid
const route = (logger: SdkLogger, url: URL): boolean => {
  switch (url.pathname) {
    case "/log":
      return logLine(logger, url.searchParams);
    case "/hold":
      logger.hold();
      return true;
    case "/release":
      logger.release();
      return true;
    case "/flush":
      logger.flush();
      return true;
    default:
      return false;
  }
};

const main = (): void => {
  const logger = createLogger({ component: COMPONENT });
  logger.set({ logger: findAppLogger(process.env.E2E_LOGGER), logLevel: process.env.E2E_LOG_LEVEL }, COMPONENT);

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    writeStep(url.pathname);
    // Each request closes its connection, so close() is not kept waiting by an idle keep-alive socket
    response.setHeader("connection", "close");

    if (url.pathname === "/close") {
      response.writeHead(204).end(() => {
        server.close();
      });
      return;
    }

    response.writeHead(route(logger, url) ? 204 : 400).end();
  });

  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address() as AddressInfo; // listen() on a TCP port always gives an AddressInfo
    // The IPC channel would keep the process alive; the tests check that nothing else does. Disconnected once the
    // message is sent, since a message still queued when the channel closes is lost
    process.send?.({ port }, () => {
      process.disconnect?.();
    });
  });
};

main();
