import { describe, expect, it } from "vitest";

import { readHubFrame } from "./inbound.js";

describe("readHubFrame()", () => {
  it("returns a breakpoints message as a message", () => {
    const text = '{"version":1,"type":"breakpoints","breakpoints":[]}';

    const frame = readHubFrame(text);

    expect(frame).toEqual({ kind: "message", message: { version: 1, type: "breakpoints", breakpoints: [] } });
  });

  it("rejects a message of another protocol version", () => {
    const frame = readHubFrame('{"version":2,"type":"breakpoints","breakpoints":[]}');

    expect(frame).toEqual({
      kind: "rejected",
      reason: "the hub sent a message of protocol version 2; the session speaks 1",
    });
  });

  it("rejects an unknown type of another protocol version", () => {
    const frame = readHubFrame('{"version":2,"type":"future"}');

    expect(frame).toEqual({
      kind: "rejected",
      reason: "the hub sent a message of protocol version 2; the session speaks 1",
    });
  });

  it("ignores a binary frame with a warning", () => {
    const frame = readHubFrame(undefined);

    expect(frame).toEqual({ kind: "ignored", level: "warn", reason: "ignored a binary frame from the hub" });
  });

  it("ignores a frame that is not valid JSON with a warning", () => {
    const frame = readHubFrame("{not json");

    expect(frame).toEqual({
      kind: "ignored",
      level: "warn",
      reason: "ignored a frame from the hub that is not valid JSON",
    });
  });

  it.each([
    { name: "no version", text: '{"type":"breakpoints","breakpoints":[]}' },
    { name: "a string version", text: '{"version":"1","type":"breakpoints","breakpoints":[]}' },
    { name: "no type", text: '{"version":1}' },
    { name: "a numeric type", text: '{"version":1,"type":7}' },
    { name: "null", text: "null" },
    { name: "an array", text: "[1]" },
    { name: "a number", text: "1" },
  ])("ignores a frame with $name with a warning", ({ text }) => {
    const frame = readHubFrame(text);

    expect(frame).toEqual({
      kind: "ignored",
      level: "warn",
      reason: "ignored a message from the hub without a numeric version and a string type",
    });
  });

  it.each(["hello", "batch", "breakpointStatus", "snapshot"])("ignores a %s message with a warning", (type) => {
    const frame = readHubFrame(`{"version":1,"type":"${type}"}`);

    expect(frame).toEqual({
      kind: "ignored",
      level: "warn",
      reason: `ignored a ${type} message from the hub; only the SDK sends it`,
    });
  });

  it.each(["future", "toString", "__proto__", "constructor"])(
    "ignores a message of unknown type %s at debug",
    (type) => {
      const frame = readHubFrame(`{"version":1,"type":"${type}"}`);

      expect(frame).toEqual({
        kind: "ignored",
        level: "debug",
        reason: "ignored a message of an unknown type from the hub",
      });
    },
  );

  it("ignores a later welcome at debug", () => {
    const frame = readHubFrame('{"version":1,"type":"welcome"}');

    expect(frame).toEqual({
      kind: "ignored",
      level: "debug",
      reason: "ignored a welcome from the hub after the first one",
    });
  });
});
