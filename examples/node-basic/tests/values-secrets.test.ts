import { E2E_TEST_TIMEOUT_MS, useProcesses } from "@micafox/testkit";
import { describe, expect, it } from "vitest";

import { captureValues, readVariable } from "./values-capture.js";

// A distinctive value, so a match in the output can only be a leak
const SECRET = "values-secret-7c3d92";
const REDACTED = { type: "redacted" };

describe("snapshot of secrets nested in values", { timeout: E2E_TEST_TIMEOUT_MS }, () => {
  useProcesses();

  it("redacts a secret at every depth, in an array and under a Map key, and prints its value nowhere", async () => {
    const { snapshot, httpStatus, hub, app } = await captureValues("secrets", {
      secret: SECRET,
      limits: { maxDepth: 5 },
    });

    const string = (value: string): unknown => ({ type: "string", value, length: value.length });
    const plain = (properties: Array<{ name: string; value: unknown }>): unknown => ({
      type: "object",
      className: "Object",
      properties,
    });
    expect({
      httpStatus,
      login: readVariable(snapshot, "login"),
      settings: readVariable(snapshot, "settings"),
      accounts: readVariable(snapshot, "accounts"),
      headers: readVariable(snapshot, "headers"),
      leaks: [...hub.lines, ...app.lines].filter((line) => line.includes(SECRET)),
    }).toEqual({
      httpStatus: 200,
      login: plain([
        { name: "user", value: string("ada") },
        { name: "password", value: REDACTED },
      ]),
      settings: plain([
        { name: "theme", value: string("dark") },
        {
          name: "account",
          value: plain([
            { name: "owner", value: string("ada") },
            {
              name: "nested",
              value: plain([{ name: "deeper", value: plain([{ name: "cookie", value: REDACTED }]) }]),
            },
          ]),
        },
      ]),
      accounts: {
        type: "array",
        length: 2,
        items: [
          plain([
            { name: "id", value: { type: "number", value: 1 } },
            { name: "token", value: REDACTED },
          ]),
          plain([{ name: "id", value: { type: "number", value: 2 } }]),
        ],
      },
      headers: { type: "map", size: 1, entries: [{ key: string("authorization"), value: REDACTED }] },
      leaks: [],
    });
  });
});
