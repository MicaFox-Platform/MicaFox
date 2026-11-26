import { describe, expect, it } from "vitest";

import { createSdkCounts, parseFrame } from "../routing.js";

const frame = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));
const status = { version: 1, module: "debugger", type: "breakpointStatus", breakpointId: "b1.1", status: "active" };

// A value nested `levels` deep in total, counting the object around it as level 1
const nested = (levels: number): unknown => {
  let value: unknown = {};
  for (let level = 1; level < levels; level += 1) {
    value = { child: value };
  }
  return value;
};

describe("parseFrame", () => {
  it("reads a message", () => {
    expect(parseFrame(frame(status), false, 1)).toEqual({ messages: [status], sanitized: 0 });
  });

  it("reads the messages of a batch in order", () => {
    const second = { ...status, breakpointId: "b2.1" };

    expect(parseFrame(frame({ version: 1, type: "batch", messages: [status, second] }), false, 1)).toEqual({
      messages: [status, second],
      sanitized: 0,
    });
  });

  it("reads a frame the socket delivered in fragments", () => {
    const text = JSON.stringify(status);
    const fragments = [Buffer.from(text.slice(0, 10)), Buffer.from(text.slice(10))];

    expect(parseFrame(fragments, false, 1)).toEqual({ messages: [status], sanitized: 0 });
  });

  it("reads a frame the socket delivered as an array buffer", () => {
    const { buffer } = new Uint8Array(Buffer.from(JSON.stringify(status)));

    expect(parseFrame(buffer, false, 1)).toEqual({ messages: [status], sanitized: 0 });
  });

  it("refuses a binary frame", () => {
    expect(parseFrame(frame(status), true, 1)).toEqual({ reason: "binary frame" });
  });

  it("refuses bytes that are not UTF-8", () => {
    expect(parseFrame(Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), false, 1)).toEqual({ reason: "not UTF-8 JSON" });
  });

  it("refuses text that is not JSON", () => {
    expect(parseFrame(Buffer.from("{nope"), false, 1)).toEqual({ reason: "not UTF-8 JSON" });
  });

  it.each([
    ["a number", "7"],
    ["a string", '"x"'],
    ["null", "null"],
  ])("refuses JSON that is %s", (_name, text) => {
    expect(parseFrame(Buffer.from(text), false, 1)).toEqual({ reason: "not a message" });
  });

  it.each([
    ["a version the session does not speak", { ...status, version: 2 }],
    ["no version", { type: "breakpointStatus" }],
    ["no type", { version: 1 }],
    ["an array", [status]],
  ])("refuses a frame with %s", (_name, value) => {
    expect(parseFrame(frame(value), false, 1)).toMatchObject({
      reason: expect.stringMatching(/^not a message/) as string,
    });
  });

  it("checks a message against the session's version, not the hub's newest", () => {
    const later = { ...status, version: 2 };

    expect([parseFrame(frame(later), false, 2), parseFrame(frame(status), false, 2)]).toEqual([
      { messages: [later], sanitized: 0 },
      { reason: "not a message of this version" },
    ]);
  });

  it("refuses a batch inside a batch", () => {
    const inner = { version: 1, type: "batch", messages: [status] };

    expect(parseFrame(frame({ version: 1, type: "batch", messages: [inner] }), false, 1)).toMatchObject({
      reason: "not a message of this version",
    });
  });

  it("refuses a batch with a message of another version", () => {
    const old = { ...status, version: 2 };

    expect(parseFrame(frame({ version: 1, type: "batch", messages: [status, old] }), false, 1)).toMatchObject({
      reason: "not a message of this version",
    });
  });

  it("refuses a batch without a list of messages", () => {
    expect(parseFrame(frame({ version: 1, type: "batch", messages: "no" }), false, 1)).toMatchObject({
      reason: "not a message of this version",
    });
  });

  it("accepts a frame nested 64 levels deep", () => {
    const value = { ...status, variables: nested(63) };

    expect(parseFrame(frame(value), false, 1)).toMatchObject({ sanitized: 0 });
  });

  it("refuses a frame nested 65 levels deep", () => {
    const value = { ...status, variables: nested(64) };

    expect(parseFrame(frame(value), false, 1)).toEqual({ reason: "nested too deep" });
  });

  it("refuses a frame nested so deep that JSON.parse gives up", () => {
    const text = `${"[".repeat(200_000)}${"]".repeat(200_000)}`;

    expect(parseFrame(Buffer.from(text), false, 1)).toMatchObject({ reason: expect.any(String) as string });
  });
});

describe("parseFrame replacing what Postgres cannot store", () => {
  it("replaces a NUL character in a string with U+FFFD and counts it", () => {
    const text = JSON.stringify({ ...status, message: "a\u0000b\u0000c" });

    expect(parseFrame(Buffer.from(text), false, 1)).toEqual({
      messages: [{ ...status, message: "a�b�c" }],
      sanitized: 2,
    });
  });

  it("replaces an unpaired surrogate, high or low", () => {
    const text = '{"version":1,"type":"x","a":"\\ud800!","b":"!\\udc00"}';

    expect(parseFrame(Buffer.from(text), false, 1)).toEqual({
      messages: [{ version: 1, type: "x", a: "�!", b: "!�" }],
      sanitized: 2,
    });
  });

  it("keeps a surrogate pair, which is one character", () => {
    const message = { ...status, message: "rocket 🚀" };

    expect(parseFrame(frame(message), false, 1)).toEqual({ messages: [message], sanitized: 0 });
  });

  it("replaces them in property names too", () => {
    const text = '{"version":1,"type":"x","a\\u0000b":{"c\\ud800":1}}';

    expect(parseFrame(Buffer.from(text), false, 1)).toEqual({
      messages: [{ version: 1, type: "x", "a�b": { "c�": 1 } }],
      sanitized: 2,
    });
  });

  it("keeps the later value when two keys become the same after the replacement", () => {
    const text = '{"version":1,"type":"x","a\\u0000":1,"a\\ud800":2}';

    expect(parseFrame(Buffer.from(text), false, 1)).toEqual({
      messages: [{ version: 1, type: "x", "a\uFFFD": 2 }],
      sanitized: 2,
    });
  });

  it("replaces them inside the messages of a batch and in arrays", () => {
    const text = '{"version":1,"type":"batch","messages":[{"version":1,"type":"x","list":["a\\u0000"]}]}';

    expect(parseFrame(Buffer.from(text), false, 1)).toEqual({
      messages: [{ version: 1, type: "x", list: ["a�"] }],
      sanitized: 1,
    });
  });

  it("keeps the other values of a message that needed a repair", () => {
    const text = '{"version":1,"type":"x","n":1.5,"t":true,"z":null,"s":"a\\u0000"}';

    expect(parseFrame(Buffer.from(text), false, 1)).toEqual({
      messages: [{ version: 1, type: "x", n: 1.5, t: true, z: null, s: "a�" }],
      sanitized: 1,
    });
  });
});

describe("createSdkCounts", () => {
  it("adds up by name", () => {
    const counts = createSdkCounts();

    counts.add("rate-limited");
    counts.add("rate-limited", 4);
    counts.add("sanitized", 2);

    expect(counts.list()).toEqual([
      { name: "rate-limited", count: 5 },
      { name: "sanitized", count: 2 },
    ]);
  });
});
