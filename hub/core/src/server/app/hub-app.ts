import type { FastifyInstance, FastifyTypeProvider, RawServerDefault } from "fastify";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "pino";
import type { Static, TSchema } from "typebox";

/**
 * Types a route's request and reply from its TypeBox schemas. Fastify validates TypeBox schemas as the JSON Schema
 * they are, so only the types are needed, not `@fastify/type-provider-typebox` and its run-time imports.
 */
export interface TypeBoxTypeProvider extends FastifyTypeProvider {
  validator: this["schema"] extends TSchema ? Static<this["schema"]> : unknown;
  serializer: this["schema"] extends TSchema ? Static<this["schema"]> : unknown;
}

/** The Fastify app with the hub's pino logger and routes typed from their TypeBox schemas. */
export type HubApp = FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, Logger, TypeBoxTypeProvider>;
