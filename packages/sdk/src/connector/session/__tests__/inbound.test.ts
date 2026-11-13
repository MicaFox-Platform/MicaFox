import { describe, expect, it } from "vitest";

import { readHubFrame } from "../inbound.js";

const AGREED: ReadonlySet<string> = new Set(["debugger"]);

describe("readHubFrame()", () => {
  it("returns a breakpoints message as a message", () => {
    const text = '{"version":1,"module":"debugger","type":"breakpoints","breakpoints":[]}';

    const frame = readHubFrame(text, AGREED);

    expect(frame).toEqual({
      kind: "message",
      message: { version: 1, module: "debugger", type: "breakpoints", breakpoints: [] },
    });
  });

  it("rejects a message of another protocol version", () => {
    const frame = readHubFrame('{"version":2,"type":"breakpoints","breakpoints":[]}', AGREED);

    expect(frame).toEqual({
      kind: "rejected",
      reason: "the hub sent a message of protocol version 2; the session speaks 1",
    });
  });

  it("rejects an unknown type of another protocol version", () => {
    const frame = readHubFrame('{"version":2,"type":"future"}', AGREED);

    expect(frame).toEqual({
      kind: "rejected",
      reason: "the hub sent a message of protocol version 2; the session speaks 1",
    });
  });

  it("ignores a binary frame with a warning", () => {
    const frame = readHubFrame(undefined, AGREED);

    expect(frame).toEqual({ kind: "ignored", level: "warn", reason: "ignored a binary frame from the hub" });
  });

  it("ignores a frame that is not valid JSON with a warning", () => {
    const frame = readHubFrame("{not json", AGREED);

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
    const frame = readHubFrame(text, AGREED);

    expect(frame).toEqual({
      kind: "ignored",
      level: "warn",
      reason: "ignored a message from the hub without a numeric version and a string type",
    });
  });

  it.each(["hello", "batch"])("ignores a %s message with a warning", (type) => {
    const frame = readHubFrame(`{"version":1,"type":"${type}"}`, AGREED);

    expect(frame).toEqual({
      kind: "ignored",
      level: "warn",
      reason: `ignored a ${type} message from the hub; only the SDK sends it`,
    });
  });

  it("ignores a later welcome at debug", () => {
    const frame = readHubFrame('{"version":1,"type":"welcome","modules":["debugger"]}', AGREED);

    expect(frame).toEqual({
      kind: "ignored",
      level: "debug",
      reason: "ignored a welcome from the hub after the first one",
    });
  });

  it.each([
    { name: "no module", extra: "" },
    { name: "a numeric module", extra: ',"module":7' },
    { name: "a null module", extra: ',"module":null' },
  ])("ignores a message with $name with a warning", ({ extra }) => {
    const frame = readHubFrame(`{"version":1,"type":"breakpoints"${extra}}`, AGREED);

    expect(frame).toEqual({
      kind: "ignored",
      level: "warn",
      reason: "ignored a message from the hub without a string module",
    });
  });

  it("ignores a message without a module even when its type is unknown", () => {
    const frame = readHubFrame('{"version":1,"type":"future"}', AGREED);

    expect(frame).toEqual({
      kind: "ignored",
      level: "warn",
      reason: "ignored a message from the hub without a string module",
    });
  });

  it("ignores a message of a module the SDK knows but the session did not agree on at debug", () => {
    const frame = readHubFrame('{"version":1,"module":"debugger","type":"breakpoints"}', new Set());

    expect(frame).toEqual({
      kind: "ignored",
      level: "debug",
      reason: "ignored a message of a module the session did not agree on",
    });
  });

  it("ignores a message of a module the session did not agree on before checking its type", () => {
    const frame = readHubFrame('{"version":1,"module":"errors","type":"future"}', AGREED);

    expect(frame).toEqual({
      kind: "ignored",
      level: "debug",
      reason: "ignored a message of a module the session did not agree on",
    });
  });

  it("ignores a message of an agreed module the SDK does not know at debug", () => {
    const frame = readHubFrame('{"version":1,"module":"errors","type":"future"}', new Set(["errors"]));

    expect(frame).toEqual({
      kind: "ignored",
      level: "debug",
      reason: "ignored a message of a module the SDK does not know",
    });
  });

  it.each(["toString", "__proto__", "constructor"])("treats %s as an unknown module", (module) => {
    const frame = readHubFrame(`{"version":1,"module":"${module}","type":"breakpoints"}`, new Set([module]));

    expect(frame).toEqual({
      kind: "ignored",
      level: "debug",
      reason: "ignored a message of a module the SDK does not know",
    });
  });

  it.each(["breakpointStatus", "snapshot"])("ignores a debugger %s message with a warning", (type) => {
    const frame = readHubFrame(`{"version":1,"module":"debugger","type":"${type}"}`, AGREED);

    expect(frame).toEqual({
      kind: "ignored",
      level: "warn",
      reason: `ignored a ${type} message from the hub; only the SDK sends it`,
    });
  });

  it.each(["future", "toString", "__proto__", "constructor"])(
    "ignores a debugger message of unknown type %s at debug",
    (type) => {
      const frame = readHubFrame(`{"version":1,"module":"debugger","type":"${type}"}`, AGREED);

      expect(frame).toEqual({
        kind: "ignored",
        level: "debug",
        reason: "ignored a message of an unknown type from the hub",
      });
    },
  );
});
