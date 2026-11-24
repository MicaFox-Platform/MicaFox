import type { FeatureRegistry } from "./registry.js";
import type { Entitlements } from "../access/index.js";

/** Whether an organization may use a feature or an SDK module: the one question every part of an extension asks. */
export interface Gate {
  /** Core features are always on and never ask; a feature the hub does not run is never entitled. */
  isEntitled: (orgId: string, feature: string) => Promise<boolean>;
  /** Whether `welcome` may list the SDK module for the organization: a module no feature serves is not. */
  isModuleEntitled: (orgId: string, module: string) => Promise<boolean>;
}

/**
 * Builds the gate over the features' entitlements. A source that fails makes the question throw: routes answer
 * 500 and jobs fail, so a broken source never lets a paid part through.
 */
export const createGate = (registry: FeatureRegistry, entitlements: Entitlements): Gate => {
  const entitlementByFeature = new Map(
    registry.features.map(({ feature, entitlement }) => [feature.name, entitlement]),
  );
  const featureByModule = new Map(registry.modules.map(({ feature, part }) => [part.module, feature]));

  const isEntitled: Gate["isEntitled"] = async (orgId, feature) => {
    if (!entitlementByFeature.has(feature)) {
      return false;
    }
    const entitlement = entitlementByFeature.get(feature);
    return entitlement === undefined || (await entitlements(orgId).has(entitlement));
  };

  return {
    isEntitled,
    isModuleEntitled: async (orgId, module) => {
      const feature = featureByModule.get(module);
      return feature !== undefined && (await isEntitled(orgId, feature));
    },
  };
};
