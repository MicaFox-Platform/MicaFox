import { CLOSE_CODES } from "@micafox/protocol";
import type { Hello } from "@micafox/protocol";
import { describe, expect, it } from "vitest";

import { emptyFeature, paidFeature, protocolModule } from "../../../../test/feature/fixtures.js";
import { createEntitlements } from "../../access/index.js";
import { createFeatureRegistry, createGate, defineExtension } from "../../feature/index.js";
import { agreeModules, readFirstFrame } from "../handshake.js";

const ORG = "0b6f3a52-6a3e-4e55-9d0c-6f1c1d2b8a01";

const HELLO: Hello = {
  version: 1,
  type: "hello",
  instanceId: "8f14e45f-ceea-467f-a0e6-3b5c2a1d9e7b",
  labels: { region: "eu" },
  hostname: "checkout-7d9f",
  pid: 1,
  sdk: { name: "@micafox/sdk", version: "0.1.0" },
  runtime: { name: "node", version: "22.11.0" },
  modules: ["debugger"],
};

const frameOf = (message: unknown): Buffer => Buffer.from(JSON.stringify(message));

describe("readFirstFrame", () => {
  it("reads a valid hello", () => {
    expect(readFirstFrame(frameOf(HELLO), false)).toEqual({ hello: HELLO });
  });

  it("accepts fields a later v1 SDK may add, and a commit of any form", () => {
    const hello = { ...HELLO, commit: "not-a-hash", cpus: 8 };

    expect(readFirstFrame(frameOf(hello), false)).toEqual({ hello });
  });

  it.each([
    ["a binary frame", frameOf(HELLO), true],
    ["text that is not JSON", Buffer.from("hello"), false],
    ["a message that is not a hello", frameOf({ version: 1, type: "batch", messages: [] }), false],
    ["a hello without a version", frameOf({ ...HELLO, version: "1" }), false],
    ["a hello without modules", frameOf({ ...HELLO, modules: undefined }), false],
    ["an instanceId over 64 characters", frameOf({ ...HELLO, instanceId: "i".repeat(65) }), false],
    ["an empty instanceId", frameOf({ ...HELLO, instanceId: "" }), false],
  ])("closes with protocolError on %s", (_case, data, isBinary) => {
    expect(readFirstFrame(data, isBinary)).toMatchObject({ closeCode: CLOSE_CODES.protocolError });
  });

  it("closes with incompatibleVersion on a version the hub has no types for", () => {
    expect(readFirstFrame(frameOf({ ...HELLO, version: 2 }), false)).toMatchObject({
      closeCode: CLOSE_CODES.incompatibleVersion,
    });
  });

  it("reads a hello that came in fragments", () => {
    const text = JSON.stringify(HELLO);

    expect(readFirstFrame([Buffer.from(text.slice(0, 10)), Buffer.from(text.slice(10))], false)).toEqual({
      hello: HELLO,
    });
  });
});

describe("agreeModules", () => {
  const gate = createGate(
    createFeatureRegistry(
      [emptyFeature("debugger", { protocol: protocolModule("debugger") })],
      defineExtension({ features: [paidFeature("profiler", { protocol: protocolModule("profiler") })] }),
    ),
    createEntitlements({ sources: [], now: () => 0 }),
  );

  it("keeps the modules a feature serves, once, without unknown ones or those the organization may not use", async () => {
    expect(await agreeModules(["debugger", "logs", "profiler", "debugger"], ORG, gate)).toEqual(["debugger"]);
  });
});
