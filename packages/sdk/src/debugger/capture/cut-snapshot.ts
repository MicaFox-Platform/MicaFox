import { PROTOCOL_VERSION, type CaptureLimits, type Snapshot, type Value } from "@probex-platform/protocol";

import { resolveLimits, truncateText, type ResolvedLimits } from "./limits.js";
import type { PauseRead } from "./read-pause.js";

type ObjectValue = Extract<Value, { type: "object" }>;

// Each level is cut from the read, which was made within the largest limits, so the result is never larger than it
const cutValue = (value: Value, limits: ResolvedLimits, level: number): Value => {
  if (value.type === "string") {
    return { ...value, value: truncateText(value.value, limits.maxStringLength) };
  }

  if (value.type === "error") {
    return cutError(value, limits);
  }

  if (value.type === "object") {
    return cutObject(value, limits, level);
  }

  if (value.type === "array" || value.type === "set") {
    return cutItems(value, limits, level);
  }

  return value.type === "map" ? cutEntries(value, limits, level) : value;
};

const cutError = (value: Extract<Value, { type: "error" }>, limits: ResolvedLimits): Value => ({
  ...value,
  message: truncateText(value.message, limits.maxStringLength),
  ...(value.stack === undefined ? {} : { stack: truncateText(value.stack, limits.maxStringLength) }),
});

const isBelowDepth = (limits: ResolvedLimits, level: number): boolean => level >= limits.maxDepth;

const cutObject = (value: ObjectValue, limits: ResolvedLimits, level: number): Value => {
  const { properties } = value;
  const shell: ObjectValue = { type: "object", className: value.className };
  if (properties === undefined || isBelowDepth(limits, level)) {
    return shell;
  }

  const isCut = value.truncated === true || properties.length > limits.maxItems;
  const kept = properties.slice(0, limits.maxItems).map((property) => ({
    name: property.name,
    value: cutValue(property.value, limits, level + 1),
  }));
  return isCut ? { ...shell, properties: kept, truncated: true } : { ...shell, properties: kept };
};

const cutItems = (value: Extract<Value, { type: "array" | "set" }>, limits: ResolvedLimits, level: number): Value => {
  const { items, ...shell } = value;
  const size = value.type === "array" ? value.length : value.size;
  if (items === undefined || isBelowDepth(limits, level) || size > limits.maxItems) {
    return shell;
  }

  return { ...shell, items: items.map((item) => cutValue(item, limits, level + 1)) };
};

const cutEntries = (value: Extract<Value, { type: "map" }>, limits: ResolvedLimits, level: number): Value => {
  const { entries, ...shell } = value;
  if (entries === undefined || isBelowDepth(limits, level) || value.size > limits.maxItems) {
    return shell;
  }

  return {
    ...shell,
    entries: entries.map((entry) => ({
      key: cutValue(entry.key, limits, level + 1),
      value: cutValue(entry.value, limits, level + 1),
    })),
  };
};

/** A breakpoint's id and its own limits, as the hub set them. */
export interface SnapshotTarget {
  breakpointId: string;
  limits?: CaptureLimits;
}

/**
 * The snapshot of one breakpoint: `read` cut to the breakpoint's own limits, with no inspector call. A snapshot of
 * a truncated read is truncated. O(size of the read).
 */
export const cutSnapshot = (read: PauseRead, target: SnapshotTarget): Snapshot => {
  const limits = resolveLimits(target.limits);
  const snapshot: Snapshot = {
    version: PROTOCOL_VERSION,
    type: "snapshot",
    breakpointId: target.breakpointId,
    time: read.time,
    stack: read.stack,
    variables: read.variables.map((variable) => ({ name: variable.name, value: cutValue(variable.value, limits, 0) })),
  };
  return read.truncated ? { ...snapshot, truncated: true } : snapshot;
};
