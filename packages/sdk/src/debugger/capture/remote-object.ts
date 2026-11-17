import { isRecord } from "../../connector/index.js";

/** A value as `Runtime.getProperties` describes it; only the fields the capture reads. */
export interface RemoteObject {
  readonly type: string;
  readonly subtype: string | undefined;
  readonly className: string | undefined;
  readonly value: unknown;
  readonly unserializableValue: string | undefined;
  readonly description: string | undefined;
  readonly objectId: string | undefined;
}

/** One property of an object or one variable of a scope. */
export interface Property {
  readonly name: string;
  /** Absent for an accessor, whose getter is never run. */
  readonly value: RemoteObject | undefined;
  readonly isAccessor: boolean;
  readonly isEnumerable: boolean;
}

/** The answer of `Runtime.getProperties`: own properties and V8's internal ones, such as `[[Entries]]`. */
export interface PropertyList {
  readonly properties: readonly Property[];
  readonly internal: readonly Property[];
}

const readText = (record: object, key: string): string | undefined => {
  const value: unknown = Reflect.get(record, key);
  return typeof value === "string" ? value : undefined;
};

/** Reads a RemoteObject; undefined when `raw` is not one. */
export const readRemoteObject = (raw: unknown): RemoteObject | undefined => {
  if (!isRecord(raw)) {
    return undefined;
  }

  const type = readText(raw, "type");
  if (type === undefined) {
    return undefined;
  }

  return {
    type,
    subtype: readText(raw, "subtype"),
    className: readText(raw, "className"),
    value: Reflect.get(raw, "value"),
    unserializableValue: readText(raw, "unserializableValue"),
    description: readText(raw, "description"),
    objectId: readText(raw, "objectId"),
  };
};

const readProperty = (raw: unknown): Property | undefined => {
  if (!isRecord(raw)) {
    return undefined;
  }

  const name = readText(raw, "name");
  if (name === undefined) {
    return undefined;
  }

  const value = readRemoteObject(Reflect.get(raw, "value"));
  const hasAccessor = Reflect.get(raw, "get") !== undefined || Reflect.get(raw, "set") !== undefined;
  return {
    name,
    value,
    isAccessor: value === undefined && hasAccessor,
    isEnumerable: Reflect.get(raw, "enumerable") === true,
  };
};

const readProperties = (raw: unknown): Property[] =>
  Array.isArray(raw) ? raw.flatMap((item: unknown) => readProperty(item) ?? []) : [];

/** Reads the reply of `Runtime.getProperties`; what is not a property is left out. */
export const readPropertyList = (reply: object): PropertyList => ({
  properties: readProperties(Reflect.get(reply, "result")),
  internal: readProperties(Reflect.get(reply, "internalProperties")),
});
