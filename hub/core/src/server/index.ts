// The server entry ("."): docs/architecture/hub/overview.md#packages
export { ConfigError } from "./config/index.js";
export { buildPgliteSeed } from "./db/index.js";
export type { PgliteSeedOptions } from "./db/index.js";
export { createHub, runHub, runMigrations } from "./lifecycle/index.js";
export type { Hub, HubOptions, RunHubOptions, RunHubProcess, RunMigrationsOptions } from "./lifecycle/index.js";
export { defineExtension, defineFeature, FeatureRegistryError, createFeatureRegistry } from "./feature/index.js";
export type {
  Extension,
  ExtensionFeature,
  Feature,
  FeatureAccess,
  FeatureJob,
  FeatureRegistry,
  FeatureRoutes,
  Gate,
  ProtocolModule,
  Registered,
  RetentionPolicy,
  SdkSession,
} from "./feature/index.js";
export type { EntitlementSource, OrgContext } from "./access/index.js";
export type { HubApp } from "./app/index.js";
