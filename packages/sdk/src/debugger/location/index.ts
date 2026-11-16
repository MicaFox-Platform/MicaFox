export type { LocationContext } from "./collect-candidates.js";
export {
  findAddedTargets,
  findLocation,
  mayResolveTo,
  type Location,
  type ScriptPosition,
  type SearchPlacement,
  type Target,
} from "./find-location.js";
export {
  ScriptRegistry,
  isMapped,
  isSearchable,
  toSegments,
  type MappedRecord,
  type ScriptRecord,
} from "./script-registry.js";
