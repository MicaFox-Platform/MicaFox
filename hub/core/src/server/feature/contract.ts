import type { Message } from "@micafox/protocol";
import type { FastifyRequest } from "fastify";
import type { Transaction } from "kysely";

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

/** Work a feature repeats; the scheduler runs it every `everyMs` for each organization that may use the feature. */
export interface FeatureJob {
  /** Unique across the hub. */
  name: string;
  everyMs: number;
  run: (orgId: string) => Promise<void>;
}

/** How long a feature keeps its data; `run` deletes what is older than `olderThan` in one organization. */
export interface RetentionPolicy {
  /** Unique across the hub; an operator overrides the default with `MICAFOX_RETENTION_<NAME>_DAYS`. */
  name: string;
  maxAgeDays: number;
  run: (orgId: string, olderThan: Date) => Promise<void>;
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
