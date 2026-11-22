import fastify, { LogController } from "fastify";
import type { FastifyInstance, RawServerDefault } from "fastify";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "pino";

/** The Fastify app with the hub's pino logger, whose type is narrower than Fastify's default. */
export type HubApp = FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, Logger>;

/** What the app takes from the settings. */
export interface AppOptions {
  logger: Logger;
  trustProxy: boolean | number | string[];
}

// Fastify accepts a hop count at run time but its types do not; this is what proxy-addr does for a number
const toFastifyTrustProxy = (
  setting: AppOptions["trustProxy"],
): boolean | string[] | ((address: string, hop: number) => boolean) =>
  typeof setting === "number" ? (_address, hop) => hop < setting : setting;

/** Creates the Fastify app; plugins, the error format and the web app's files come with their own cards. */
export const createApp = (options: AppOptions): HubApp =>
  fastify({
    loggerInstance: options.logger,
    trustProxy: toFastifyTrustProxy(options.trustProxy),
    // The request log line has its own fields and skips the probes: server.md#logging
    logController: new LogController({ disableRequestLogging: true }),
    // The hub answers while stopping itself, so /healthz stays 200 and the 503 is a problem document
    return503OnClosing: false,
    forceCloseConnections: "idle",
  });
