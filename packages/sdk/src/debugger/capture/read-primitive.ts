import type { Value } from "@probex-platform/protocol";

import { truncateText } from "./limits.js";
import type { RemoteObject } from "./remote-object.js";

type SpecialNumber = "NaN" | "Infinity" | "-Infinity" | "-0";

const isSpecialNumber = (text: string): text is SpecialNumber =>
  text === "NaN" || text === "Infinity" || text === "-Infinity" || text === "-0";

const unavailable = (reason: string): Value => ({ type: "unavailable", reason });

/**
 * The size V8 prints in the description of an array, typed array, `Set` or `Map`, such as `Array(3)` or
 * `Buffer(12)`; undefined when there is none. This is how a huge container is sized without reading it.
 */
export const parseSize = (description: string | undefined): number | undefined => {
  if (!description?.endsWith(")")) {
    return undefined;
  }

  const open = description.lastIndexOf("(");
  const digits = description.slice(open + 1, -1);
  return open > 0 && /^\d{1,15}$/.test(digits) ? Number(digits) : undefined;
};

const readNumber = (remote: RemoteObject): Value => {
  if (remote.unserializableValue !== undefined) {
    return isSpecialNumber(remote.unserializableValue)
      ? { type: "number", value: remote.unserializableValue }
      : unavailable("the number has an unknown form");
  }

  return typeof remote.value === "number" ? { type: "number", value: remote.value } : unavailable("malformed number");
};

// V8 describes a Date with its toString() text, or `Invalid Date`, so the ISO form keeps whole seconds
const readDate = (remote: RemoteObject): Value => {
  const milliseconds = remote.description === undefined ? Number.NaN : Date.parse(remote.description);
  return Number.isNaN(milliseconds)
    ? unavailable("the date is invalid")
    : { type: "date", value: new Date(milliseconds).toISOString() };
};

const readBigint = (remote: RemoteObject): Value => {
  const digits = remote.unserializableValue?.replace(/n$/, "");
  return digits === undefined ? unavailable("malformed bigint") : { type: "bigint", value: digits };
};

const readString = (remote: RemoteObject, maxStringLength: number): Value =>
  typeof remote.value === "string"
    ? { type: "string", value: truncateText(remote.value, maxStringLength), length: remote.value.length }
    : unavailable("malformed string");

const readScalar = (remote: RemoteObject, maxStringLength: number): Value => {
  switch (remote.type) {
    case "undefined":
      return { type: "undefined" };
    case "boolean":
      return typeof remote.value === "boolean"
        ? { type: "boolean", value: remote.value }
        : unavailable("malformed boolean");
    case "number":
      return readNumber(remote);
    case "bigint":
      return readBigint(remote);
    case "symbol":
      return { type: "symbol", value: remote.description ?? "Symbol()" };
    case "string":
      return readString(remote, maxStringLength);
    default:
      return unavailable(`the value has the unsupported type ${remote.type}`);
  }
};

/**
 * The value of a primitive, `null` or a `Date`, which V8 describes in full without another call; undefined for a
 * function or another object, which need one.
 */
export const readPrimitive = (remote: RemoteObject, maxStringLength: number): Value | undefined => {
  if (remote.type === "function") {
    return undefined;
  }

  if (remote.type !== "object") {
    return readScalar(remote, maxStringLength);
  }

  if (remote.subtype === "null") {
    return { type: "null" };
  }

  return remote.subtype === "date" ? readDate(remote) : undefined;
};
