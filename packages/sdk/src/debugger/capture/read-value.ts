import type { Value, Variable } from "@probex-platform/protocol";

import { sizeOf, type CaptureBudget } from "./budget.js";
import { truncateText, type ResolvedLimits } from "./limits.js";
import { parseSize, readPrimitive } from "./read-primitive.js";
import { readPropertyList, type Property, type PropertyList, type RemoteObject } from "./remote-object.js";

/** What the capture needs of the inspector session; an `InspectorSession` fits. `post` answers and never throws. */
export interface CaptureInspector {
  post(method: string, params?: object): { ok: true; value: object } | { ok: false; error: Error };
}

/** The properties of an object, or why they could not be read. */
export type Listed = { ok: true; list: PropertyList } | { ok: false; reason: string };

type ArrayValue = Extract<Value, { type: "array" }>;

const READ_FAILED = "the inspector could not read the value";
const ENTRIES = "[[Entries]]";
// An array index: no leading zeros, so "01" is a name and not an item
const ARRAY_INDEX = /^(?:0|[1-9]\d{0,9})$/;

type EntryObjects = { ok: true; list: RemoteObject[] } | { ok: false; reason: string };

// The objects of the [[Entries]] array that stand for the first `size` entries
const toEntryObjects = (properties: readonly Property[], size: number): RemoteObject[] =>
  properties.flatMap((property) => {
    const index = toIndex(property.name);
    return index !== undefined && index < size && property.value !== undefined ? [property.value] : [];
  });

const unavailable = (reason: string): Value => ({ type: "unavailable", reason });

const toIndex = (name: string): number | undefined => (ARRAY_INDEX.test(name) ? Number(name) : undefined);

const findProperty = (properties: readonly Property[], name: string): Property | undefined =>
  properties.find((property) => property.name === name);

const textOf = (property: Property | undefined): string | undefined => {
  const value = property?.value?.value;
  return typeof value === "string" ? value : undefined;
};

/**
 * Reads values into the protocol's `Value` tree, depth first, with `Runtime.getProperties` only: it never runs a
 * getter and evaluates nothing. Every call is checked against the budget first. The recursion is as deep as
 * `maxDepth`, at most 5, plus the entry of a map.
 */
export class ValueReader {
  constructor(
    private readonly inspector: CaptureInspector,
    private readonly limits: ResolvedLimits,
    private readonly budget: CaptureBudget,
  ) {}

  /** Reads the own properties of `objectId` in one call, unless the budget is spent. */
  list(objectId: string): Listed {
    const exhausted = this.budget.stopReason();
    if (exhausted !== undefined) {
      return { ok: false, reason: exhausted };
    }

    const reply = this.inspector.post("Runtime.getProperties", { objectId, ownProperties: true });
    return reply.ok ? { ok: true, list: readPropertyList(reply.value) } : { ok: false, reason: READ_FAILED };
  }

  /** Why the next value may not be read, or undefined while there is budget left; a reason truncates the read. */
  stopReason(): string | undefined {
    return this.budget.stopReason();
  }

  /** Whether the budget still allows a read. */
  canRead(): boolean {
    return this.budget.exhaustedReason() === undefined;
  }

  /** Reads a variable of a scope and counts its name. */
  readVariable(property: Property): Variable {
    this.budget.charge(property.name.length + 16);
    return { name: property.name, value: this.readMember(property, 0) };
  }

  /** Reads the value of a property or variable, which is `level` objects below its variable; a getter is `accessor`. */
  readMember(property: Property | undefined, level: number): Value {
    if (property?.isAccessor === true) {
      return { type: "accessor" };
    }

    return property?.value === undefined ? unavailable(READ_FAILED) : this.readValue(property.value, level);
  }

  /** Reads `remote` and what is below it; `level` is 0 for a variable's own value. */
  readValue(remote: RemoteObject, level: number): Value {
    const exhausted = this.budget.stopReason();
    if (exhausted !== undefined) {
      return unavailable(exhausted);
    }

    const value = readPrimitive(remote, this.limits.maxStringLength) ?? this.readReference(remote, level);
    this.budget.charge(sizeOf(value));
    return value;
  }

  private readReference(remote: RemoteObject, level: number): Value {
    if (remote.type === "function") {
      return this.readFunction(remote);
    }

    const { subtype } = remote;
    if (subtype === "array" || subtype === "typedarray") {
      return this.readArray(remote, level);
    }

    if (subtype === "set" || subtype === "map") {
      return this.readCollection(remote, level);
    }

    return subtype === "error" ? this.readError(remote) : this.readObject(remote, level);
  }

  // The name is an own property; the description would miss the name an arrow function gets from its variable
  private readFunction(remote: RemoteObject): Value {
    const listed = remote.objectId === undefined ? undefined : this.list(remote.objectId);
    if (listed !== undefined && !listed.ok) {
      return unavailable(listed.reason);
    }

    return { type: "function", name: textOf(findProperty(listed?.list.properties ?? [], "name")) ?? "" };
  }

  private readError(remote: RemoteObject): Value {
    const className = remote.className ?? "Error";
    if (remote.objectId === undefined) {
      return unavailable(READ_FAILED);
    }

    const listed = this.list(remote.objectId);
    if (!listed.ok) {
      return unavailable(listed.reason);
    }

    const { maxStringLength } = this.limits;
    const message = truncateText(textOf(findProperty(listed.list.properties, "message")) ?? "", maxStringLength);
    const stack = textOf(findProperty(listed.list.properties, "stack"));
    return stack === undefined
      ? { type: "error", className, message }
      : { type: "error", className, message, stack: truncateText(stack, maxStringLength) };
  }

  private readObject(remote: RemoteObject, level: number): Value {
    const className = remote.className ?? "Object";
    if (remote.objectId === undefined || level >= this.limits.maxDepth) {
      return { type: "object", className };
    }

    const listed = this.list(remote.objectId);
    if (!listed.ok) {
      return unavailable(listed.reason);
    }

    const enumerable = listed.list.properties.filter((property) => property.isEnumerable);
    const properties = this.readProperties(enumerable, level + 1);
    return enumerable.length > properties.read
      ? { type: "object", className, properties: properties.variables, truncated: true }
      : { type: "object", className, properties: properties.variables };
  }

  // When the budget runs out, the first property left says why and the others are left out, so the snapshot stays
  // within its size
  private readProperties(enumerable: readonly Property[], level: number): { variables: Variable[]; read: number } {
    const variables: Variable[] = [];
    for (const property of enumerable.slice(0, this.limits.maxItems)) {
      const reason = this.budget.stopReason();
      if (reason !== undefined) {
        variables.push({ name: property.name, value: unavailable(reason) });
        return { variables, read: variables.length - 1 };
      }

      this.budget.charge(property.name.length + 16);
      variables.push({ name: property.name, value: this.readMember(property, level) });
    }

    return { variables, read: variables.length };
  }

  // An array or typed array is sized from its description, and read only when it fits: a huge one costs no call
  private readArray(remote: RemoteObject, level: number): Value {
    const length = parseSize(remote.description);
    if (length === undefined) {
      return unavailable("the length of the array is unknown");
    }

    const shell: ArrayValue = { type: "array", length };
    if (remote.objectId === undefined || length > this.limits.maxItems || level >= this.limits.maxDepth) {
      return shell;
    }

    const listed = this.list(remote.objectId);
    if (!listed.ok) {
      return unavailable(listed.reason);
    }

    const byIndex = new Map<number, Property>();
    for (const property of listed.list.properties) {
      const index = toIndex(property.name);
      if (index !== undefined && index < length) {
        byIndex.set(index, property);
      }
    }

    const items = this.readItems(byIndex, length, level + 1);
    return items === undefined ? shell : { ...shell, items };
  }

  // A hole reads as undefined, as it does in the app. When the budget runs out there are no items, which means not
  // read, so the snapshot stays within its size
  private readItems(byIndex: ReadonlyMap<number, Property>, length: number, level: number): Value[] | undefined {
    const items: Value[] = [];
    for (let index = 0; index < length; index += 1) {
      if (this.budget.stopReason() !== undefined) {
        return undefined;
      }

      const property = byIndex.get(index);
      items.push(property === undefined ? { type: "undefined" } : this.readMember(property, level));
    }

    return items;
  }

  // A Set or Map is sized from its description; its entries are read through [[Entries]] only when they fit
  private readCollection(remote: RemoteObject, level: number): Value {
    const size = parseSize(remote.description);
    if (size === undefined) {
      return unavailable("the size of the collection is unknown");
    }

    const isMap = remote.subtype === "map";
    if (remote.objectId === undefined || size > this.limits.maxItems || level >= this.limits.maxDepth) {
      return isMap ? { type: "map", size } : { type: "set", size };
    }

    const entries = this.listEntries(remote.objectId, size);
    if (!entries.ok) {
      return unavailable(entries.reason);
    }

    const children = this.readEntries(entries.list, level + 1);
    if (children === undefined) {
      return isMap ? { type: "map", size } : { type: "set", size };
    }

    return isMap
      ? {
          type: "map",
          size,
          entries: children.map(({ key, value }) => ({ key: key ?? unavailable(READ_FAILED), value })),
        }
      : { type: "set", size, items: children.map(({ value }) => value) };
  }

  private listEntries(objectId: string, size: number): EntryObjects {
    const collection = this.list(objectId);
    if (!collection.ok) {
      return collection;
    }

    const entriesId = findProperty(collection.list.internal, ENTRIES)?.value?.objectId;
    if (entriesId === undefined) {
      return { ok: false, reason: READ_FAILED };
    }

    const entries = this.list(entriesId);
    return entries.ok ? { ok: true, list: toEntryObjects(entries.list.properties, size) } : entries;
  }

  // Left out when the budget runs out, as the items of an array are
  private readEntries(
    entries: readonly RemoteObject[],
    level: number,
  ): Array<{ key?: Value; value: Value }> | undefined {
    const children: Array<{ key?: Value; value: Value }> = [];
    for (const entry of entries) {
      if (this.budget.stopReason() !== undefined) {
        return undefined;
      }

      children.push(this.readEntry(entry, level));
    }

    return children;
  }

  // The entry of a Set has a `value`, that of a Map a `key` and a `value`
  private readEntry(entry: RemoteObject, level: number): { key?: Value; value: Value } {
    const listed: Listed =
      entry.objectId === undefined ? { ok: false, reason: READ_FAILED } : this.list(entry.objectId);
    if (!listed.ok) {
      return { key: unavailable(listed.reason), value: unavailable(listed.reason) };
    }

    // The key is read first, so the values come in the order of the map
    const keyProperty = findProperty(listed.list.properties, "key");
    const key = keyProperty === undefined ? undefined : this.readMember(keyProperty, level);
    const value = this.readMember(findProperty(listed.list.properties, "value"), level);
    return key === undefined ? { value } : { key, value };
  }
}
