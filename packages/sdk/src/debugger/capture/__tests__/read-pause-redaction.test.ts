import type { Value, Variable } from "@micafox/protocol";
import { describe, expect, it } from "vitest";

import {
  data,
  FakeInspector,
  number,
  pausedAt,
  reference,
  text,
  type Remote,
} from "../../../../test/capture/fake-inspector.js";
import { readRealPause } from "../../../../test/capture/real-pause.js";
import { resolveRedaction } from "../../redaction/index.js";
import { readPause, type PauseRead } from "../index.js";

const isSecret = (name: string): boolean => name.toLowerCase().includes("password");

const REDACTED: Value = { type: "redacted" };

// Reads the variables that `body` declares in the real V8, with `isSecret` as the rule
const readVariables = (body: string, rule: (name: string) => boolean = isSecret) =>
  readRealPause(body, { dependencies: { isSecret: rule } });

const find = (variables: Variable[], name: string): Value | undefined =>
  variables.find((variable) => variable.name === name)?.value;

// Reads a pause of the fake inspector, whose frame has the given receiver and a local scope
const readFake = (inspector: FakeInspector, rule: (name: string) => boolean, receiver?: Remote): PauseRead =>
  readPause(
    pausedAt({ ...(receiver === undefined ? {} : { receiver }), scopes: [{ type: "local", objectId: "local" }] }),
    [undefined],
    { session: inspector, locateFrame: () => ({ file: "/app/a.js", line: 1, column: 1 }), isSecret: rule },
  );

describe("readPause redaction", () => {
  it("replaces a variable under a secret name with redacted and drops its primitive", () => {
    const { read, logged } = readVariables('const dbPassword = "hunter2"; const user = "ann";');

    expect({
      dbPassword: find(read.variables, "dbPassword"),
      user: find(read.variables, "user"),
      json: JSON.stringify(read),
      logs: JSON.stringify(logged),
    }).toEqual({
      dbPassword: REDACTED,
      user: { type: "string", value: "ann", length: 3 },
      json: expect.not.stringContaining("hunter2") as unknown,
      logs: expect.not.stringContaining("hunter2") as unknown,
    });
  });

  it("never lists the object under a secret name", () => {
    const inspector = new FakeInspector();
    inspector.define("local", [data("password", reference("secret")), data("order", reference("order"))]);
    inspector.define("secret", [data("pin", number(1234))]);
    inspector.define("order", [data("id", number(7))]);

    const { variables } = readFake(inspector, isSecret);

    expect({
      password: find(variables, "password"),
      listed: [inspector.callsAbout("secret"), inspector.callsAbout("order")],
    }).toEqual({ password: REDACTED, listed: [0, 1] });
  });

  it("never lists the object under a secret property, at any depth", () => {
    const inspector = new FakeInspector();
    inspector.define("local", [data("config", reference("config"))]);
    inspector.define("config", [data("db", reference("db"))]);
    inspector.define("db", [data("dbPassword", reference("secret")), data("host", text("db"))]);
    inspector.define("secret", [data("pin", number(1234))]);

    const { variables } = readFake(inspector, isSecret);

    expect(JSON.stringify(find(variables, "config"))).toBe(
      '{"type":"object","className":"Object","properties":[{"name":"db","value":{"type":"object","className":"Object",' +
        '"properties":[{"name":"dbPassword","value":{"type":"redacted"}},{"name":"host","value":{"type":"string","value":"db","length":2}}]}}]}',
    );
    expect(inspector.callsAbout("secret")).toBe(0);
  });

  it("redacts a getter under a secret name without running it", () => {
    const { read } = readVariables("const v = { get password() { throw new Error('ran'); } };");

    expect(find(read.variables, "v")).toEqual({
      type: "object",
      className: "Object",
      properties: [{ name: "password", value: REDACTED }],
    });
  });

  it("redacts the value of a map entry under a secret string key and never lists it", () => {
    const inspector = new FakeInspector();
    inspector.define("local", [data("v", reference("map", { subtype: "map", description: "Map(2)" }))]);
    inspector.define("map", [], [data("[[Entries]]", reference("entries"))]);
    inspector.define("entries", [data("0", reference("entry0")), data("1", reference("entry1"))]);
    inspector.define("entry0", [data("key", text("dbPassword")), data("value", reference("secret"))]);
    inspector.define("entry1", [data("key", text("host")), data("value", text("db"))]);
    inspector.define("secret", [data("pin", number(1234))]);

    const { variables } = readFake(inspector, isSecret);

    expect({ v: find(variables, "v"), listed: inspector.callsAbout("secret") }).toEqual({
      v: {
        type: "map",
        size: 2,
        entries: [
          { key: { type: "string", value: "dbPassword", length: 10 }, value: REDACTED },
          { key: { type: "string", value: "host", length: 4 }, value: { type: "string", value: "db", length: 2 } },
        ],
      },
      listed: 0,
    });
  });

  it("does not match a map key that is not a string", () => {
    const { read } = readVariables("const v = new Map([[1, 'one']]);", (name) => name === "1");

    expect(find(read.variables, "v")).toEqual({
      type: "map",
      size: 1,
      entries: [{ key: { type: "number", value: 1 }, value: { type: "string", value: "one", length: 3 } }],
    });
  });

  it("does not match array items", () => {
    const { read } = readVariables("const v = ['a', 'b'];", (name) => name === "0" || name === "1");

    expect(find(read.variables, "v")).toEqual({
      type: "array",
      length: 2,
      items: [
        { type: "string", value: "a", length: 1 },
        { type: "string", value: "b", length: 1 },
      ],
    });
  });

  it("redacts this without listing it when a rule matches the name this", () => {
    const inspector = new FakeInspector();
    inspector.define("local", []);
    inspector.define("receiver", [data("pin", number(1234))]);

    const { variables } = readFake(inspector, (name) => name === "this", reference("receiver"));

    expect({ self: find(variables, "this"), listed: inspector.callsAbout("receiver") }).toEqual({
      self: REDACTED,
      listed: 0,
    });
  });

  it("does not scan the contents of a string", () => {
    const url = "postgres://app:hunter2@db/orders?password=hunter2";
    const { read } = readVariables(`const v = ${JSON.stringify(url)};`);

    expect(find(read.variables, "v")).toEqual({ type: "string", value: url, length: url.length });
  });

  it("redacts the built-in names with the rules that run() resolves", () => {
    const rules = resolveRedaction(undefined, {}, () => undefined);
    const { read } = readVariables(
      'const api_key = "k-123"; const headers = { Authorization: "Bearer abc", accept: "json" };',
      (name) => rules.isSecret(name),
    );

    expect({
      apiKey: find(read.variables, "api_key"),
      headers: find(read.variables, "headers"),
      json: JSON.stringify(read),
    }).toEqual({
      apiKey: REDACTED,
      headers: {
        type: "object",
        className: "Object",
        properties: [
          { name: "Authorization", value: REDACTED },
          { name: "accept", value: { type: "string", value: "json", length: 4 } },
        ],
      },
      json: expect.not.stringMatching(/k-123|Bearer abc/) as unknown,
    });
  });
});
