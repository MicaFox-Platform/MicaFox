// The feature contract: docs/architecture/hub/features.md
export { defineExtension, defineFeature } from "./contract.js";
export type {
  Extension,
  ExtensionFeature,
  Feature,
  FeatureAccess,
  FeatureJob,
  FeatureRoutes,
  ProtocolModule,
  RetentionPolicy,
  SdkSession,
} from "./contract.js";
export { createGate } from "./gate.js";
export type { Gate } from "./gate.js";
export { createFeatureRegistry, FeatureRegistryError } from "./registry.js";
export type { FeatureRegistry, Registered } from "./registry.js";
export { addFeatureRoutes } from "./routes.js";
export type { FeatureRoutesOptions } from "./routes.js";
