import path from "node:path";
import { describe, expect, it } from "vitest";

import { compileConsumer } from "./compile-consumer.js";

const PACKAGE_DIR = path.resolve(import.meta.dirname, "../../..");

// Uses a value and a type of the package, so a missing or mismatched declaration fails the compile
const CONSUMER = `
  import { PROTOCOL_VERSION, type ConnectorStatus } from "@micafox/protocol";

  export const status: ConnectorStatus = "connected";
  export const version: number = PROTOCOL_VERSION;
`;

describe("the declarations of the built @micafox/protocol", () => {
  it("type a CommonJS app with the CommonJS build", async () => {
    const result = await compileConsumer({ "app.cts": CONSUMER });

    expect(result).toMatchObject({
      code: 0,
      output: expect.stringContaining(path.join(PACKAGE_DIR, "dist/cjs/index.d.ts")) as string,
    });
  });

  it("type an ES module app with the ES module build", async () => {
    const result = await compileConsumer({ "app.mts": CONSUMER });

    expect(result).toMatchObject({
      code: 0,
      output: expect.stringContaining(path.join(PACKAGE_DIR, "dist/esm/index.d.ts")) as string,
    });
  });
});
