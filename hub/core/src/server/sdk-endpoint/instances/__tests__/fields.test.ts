import { describe, expect, it } from "vitest";

import { helloOf } from "../../../../../test/sdk-endpoint/sdk-client.js";
import { cutFields } from "../fields.js";

describe("cutFields", () => {
  it("keeps the fields of a hello that fit, and counts nothing", () => {
    const result = cutFields(helloOf({ commit: "abc123", labels: { region: "eu" } }), ["debugger"]);

    expect(result).toEqual({
      cut: 0,
      replaced: 0,
      fields: {
        service: "checkout",
        labels: { region: "eu" },
        hostname: "checkout-7d9f",
        pid: 1,
        sdkName: "@micafox/sdk",
        sdkVersion: "0.1.0",
        runtimeName: "node",
        runtimeVersion: process.versions.node,
        modules: ["debugger"],
        commit: "abc123",
        protocolVersion: 1,
      },
    });
  });

  it("stores no service and no commit that the hello leaves out", () => {
    const { service, commit, modules } = cutFields(helloOf({ service: undefined }), []).fields;

    expect([service, commit, modules]).toEqual([null, null, []]);
  });

  it("stores the modules the session agreed on, not the ones the SDK listed", () => {
    const { fields } = cutFields(helloOf({ modules: ["debugger", "profiler", "x".repeat(10_000)] }), ["debugger"]);

    expect(fields.modules).toEqual(["debugger"]);
  });

  it("cuts the service, the hostname, the SDK and runtime names and versions and the commit at their limits", () => {
    const long = "x".repeat(1000);

    const { fields, cut } = cutFields(
      helloOf({
        service: long,
        hostname: long,
        sdk: { name: long, version: long },
        runtime: { name: long, version: long },
        commit: long,
      }),
      [],
    );

    expect(
      [
        fields.service,
        fields.hostname,
        fields.sdkName,
        fields.sdkVersion,
        fields.runtimeName,
        fields.runtimeVersion,
        fields.commit,
      ].map((value) => value?.length),
    ).toEqual([128, 255, 64, 64, 64, 64, 64]);
    expect(cut).toBe(7);
  });

  it("keeps the first 32 labels and cuts their keys at 64 and their values at 256 characters", () => {
    const labels = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`label-${String(index)}`, "v"]));
    labels[`k${"x".repeat(100)}`] = "y".repeat(300);

    const first = cutFields(helloOf({ labels }), []);
    const second = cutFields(helloOf({ labels: { ["k".repeat(100)]: "v".repeat(300) } }), []);

    expect(Object.keys(first.fields.labels)).toHaveLength(32);
    expect(first.cut).toBe(9);
    expect(second.fields.labels).toEqual({ ["k".repeat(64)]: "v".repeat(256) });
    expect(second.cut).toBe(2);
  });

  it("keeps a label named __proto__ as any other", () => {
    const labels = JSON.parse('{"__proto__":"x","region":"eu"}') as Record<string, string>;

    const { fields, cut } = cutFields(helloOf({ labels }), []);

    expect([Object.keys(fields.labels), fields.labels.__proto__, cut]).toEqual([["__proto__", "region"], "x", 0]);
  });

  it("counts a label lost to another whose key became the same once cut", () => {
    const labels = { [`${"k".repeat(64)}a`]: "1", [`${"k".repeat(64)}b`]: "2" };

    const { fields, cut } = cutFields(helloOf({ labels }), []);

    // Two keys cut, and one label lost to the other
    expect([fields.labels, cut]).toEqual([{ ["k".repeat(64)]: "2" }, 3]);
  });

  it("replaces NUL and unpaired surrogates with U+FFFD, in keys too, and counts them apart from the cuts", () => {
    const { fields, cut, replaced } = cutFields(
      helloOf({ hostname: "a\u0000b", labels: { "k\uD800": "v\uDC00" }, service: "ok" }),
      [],
    );

    expect([fields.hostname, fields.labels, replaced, cut]).toEqual(["a�b", { "k�": "v�" }, 3, 0]);
  });

  it("never leaves half of a surrogate pair at a cut", () => {
    const emoji = "\u{1F600}";

    const { fields } = cutFields(helloOf({ service: emoji.repeat(100) }), []);

    // 128 units hold 64 whole emoji; an odd limit would cut one in half
    expect(fields.service).toBe(emoji.repeat(64));
    expect(cutFields(helloOf({ sdk: { name: `${"x".repeat(63)}${emoji}`, version: "1" } }), []).fields.sdkName).toBe(
      "x".repeat(63),
    );
  });

  it.each([-1, 1.5, 3_000_000_000, Number.MAX_SAFE_INTEGER])("stores pid %s as 0 and counts it", (pid) => {
    const { fields, cut } = cutFields(helloOf({ pid }), []);

    expect([fields.pid, cut]).toEqual([0, 1]);
  });
});
