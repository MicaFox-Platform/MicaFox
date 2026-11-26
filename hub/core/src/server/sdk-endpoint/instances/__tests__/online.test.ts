import { describe, expect, it } from "vitest";

import { OnlineInstances } from "../online.js";

const instance = (instanceId: string, environmentId = "production") => ({ orgId: "org", environmentId, instanceId });

describe("OnlineInstances", () => {
  it("lists the instances that are online, by environment", () => {
    const online = new OnlineInstances();

    online.add(instance("a"));
    online.add(instance("b"));
    online.add(instance("c", "staging"));

    expect(online.idsOf("production")).toEqual(["a", "b"]);
    expect(online.idsOf("staging")).toEqual(["c"]);
    expect(online.idsOf("unknown")).toEqual([]);
    expect(online.list().map((entry) => entry.instanceId)).toEqual(["a", "b", "c"]);
  });

  it("takes an instance offline once its session is removed", () => {
    const online = new OnlineInstances();
    const entry = online.add(instance("a"));

    expect(online.remove(entry)).toBe(true);
    expect([online.idsOf("production"), online.list()]).toEqual([[], []]);
  });

  it("keeps the instance online when the session that was replaced is removed", () => {
    const online = new OnlineInstances();
    const replaced = online.add(instance("a"));
    const current = online.add(instance("a"));

    expect(online.remove(replaced)).toBe(false);
    expect(online.idsOf("production")).toEqual(["a"]);
    expect(online.remove(current)).toBe(true);
    expect(online.idsOf("production")).toEqual([]);
  });

  it("answers false when an entry is removed twice", () => {
    const online = new OnlineInstances();
    const entry = online.add(instance("a"));
    online.remove(entry);

    expect(online.remove(entry)).toBe(false);
  });
});
