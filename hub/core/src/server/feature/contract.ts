import type { Message } from "@micafox/protocol";
import type { FastifyRequest } from "fastify";
import type { Transaction } from "kysely";
import type { Logger } from "pino";

import type { EntitlementSource, OrgContext } from "../access/index.js";
import type { HubApp } from "../app/index.js";
import type { HubTables, Migration } from "../db/index.js";

/** What the SDK endpoint knows of a connected instance, as it hands it to a feature's protocol module. */
export interface SdkSession {
  orgId: string;
  projectId: string;
  environmentId: string;
  instanceId: string;
}

/** The SDK module a feature serves: `state` brings an instance up to date, `onMessage` handles its messages. */
export interface ProtocolModule {
  /** The module name of the messages, unique across the hub. */
  module: string;
  state: (session: SdkSession) => Promise<readonly Message[]>;
  onMessage: (session: SdkSession, message: Message) => Promise<void>;
}

/** What a job's run gets for one organization: docs/architecture/hub/server.md#jobs. */
export interface JobContext {
  orgId: string;
  /** Aborts when the run reaches its time limit or the hub stops: end the work at the next safe point. */
  signal: AbortSignal;
  /** The hub's logger with the job and the organization bound. */
  log: Logger;
  /** Runs `run` in a transaction that sees and writes only the rows of `orgId`: `db.forOrg(orgId, run)`. */
  forOrg: <T>(run: (db: Transaction<HubTables>) => Promise<T>) => Promise<T>;
}

/** Work a feature repeats; the scheduler runs it every `everyMs` for each organization that may use the feature. */
export interface FeatureJob {
  /** Unique across the hub. */
  name: string;
  /** At most 2³¹ − 1 ms, about 24 days, the longest a timer waits. */
  everyMs: number;
  run: (context: JobContext) => Promise<void>;
}

/** What one batch of a retention policy gets: docs/architecture/hub/database.md#keeping-data-within-bounds. */
export interface RetentionContext {
  orgId: string;
  /** Delete the organization's rows older than this. */
  olderThan: Date;
  /** Delete at most this many rows; the runner calls again while a batch deletes `limit`. */
  limit: number;
  /** A `db.system` transaction, which sees every organization's rows: filter by `orgId`. */
  db: Transaction<HubTables>;
}

/** How long a feature keeps its data; `run` deletes one batch of what is too old and returns how many rows it deleted. */
export interface RetentionPolicy {
  /** Unique across the hub; an operator overrides the default with `MICAFOX_RETENTION_<NAME>_DAYS`. */
  name: string;
  maxAgeDays: number;
  run: (context: RetentionContext) => Promise<number>;
}

/**
 * What a feature's routes get for an organization. Each call is the core's own, and the gate of an extension's
 * feature sits inside it: an organization without the entitlement is 403 `entitlement-required`.
 */
export interface FeatureAccess {
  /** The context of organization `orgId`; 404 for a non-member, so nothing says the organization exists. */
  inOrganization: (request: FastifyRequest, orgId: string) => Promise<OrgContext>;
  /** Runs `run` in the first organization of the actor that holds what it looks for (`undefined` means none). */
  inOwningOrg: <T>(
    request: FastifyRequest,
    run: (db: Transaction<HubTables>, context: OrgContext) => Promise<T | undefined>,
  ) => Promise<T>;
  /** 403 `forbidden` unless the actor may do `action` in the organization of `context`. */
  requireCan: (context: OrgContext, action: string) => void;
}

/** A feature's routes: a Fastify plugin the hub registers encapsulated under the feature's path. */
export type FeatureRoutes = (app: HubApp, access: FeatureAccess) => void | Promise<void>;

/** A package's part of the hub: docs/architecture/hub/features.md#server-part. */
export interface Feature {
  /** Lowercase letters, digits and dashes; unique. Routes sit under `/api/v1/<name>`, events are `<name>.*`. */
  name: string;
  server: FeatureRoutes;
  /** UI-only routes under `/api/internal/<name>`, not public API. */
  internal?: FeatureRoutes;
  /** Migration modules in order, forward-only; they run as the package `<name>`. */
  migrations?: readonly Migration[];
  jobs?: readonly FeatureJob[];
  retention?: readonly RetentionPolicy[];
  protocol?: ProtocolModule;
}

/** A feature of the extension: the hub serves it to the organizations that have its entitlement. */
export type ExtensionFeature = Feature & { entitlement: string };

/** The paid features of `ee/` and where their entitlements come from. */
export interface Extension {
  features: readonly ExtensionFeature[];
  sources: readonly EntitlementSource[];
}

/** Declares a feature; the hub checks it at start. */
export const defineFeature = <T extends Feature>(feature: T): T => feature;

/** Declares the extension: features with an `entitlement`, and the sources of the entitlements, none in S2. */
export const defineExtension = (extension: {
  features: readonly ExtensionFeature[];
  sources?: readonly EntitlementSource[];
}): Extension => ({ features: extension.features, sources: extension.sources ?? [] });
