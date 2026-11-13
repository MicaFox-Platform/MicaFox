import type { BreakpointStatus } from "@micafox/protocol";
import { Buffer } from "node:buffer";
import { rmSync, truncateSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeCompiled } from "../../../../test/debugger/compiled.js";
import {
  CHECKOUT_SOURCE,
  createBreakpoints,
  TOTAL_OF_TWO_ITEMS,
  TWO_ITEMS,
  type BreakpointsUnderTest,
} from "../../../../test/debugger/real-v8.js";
import { createSourceMapText, encodeMappings } from "../../../../test/source-maps/encode-mappings.js";

let test: BreakpointsUnderTest;

beforeEach(() => {
  test = createBreakpoints();
});

afterEach(() => {
  test.dispose();
});

const status = (breakpointId: string, state: BreakpointStatus["status"], message?: string): BreakpointStatus => ({
  version: 1,
  module: "debugger",
  type: "breakpointStatus",
  breakpointId,
  status: state,
  ...(message === undefined ? {} : { message }),
});

const LOADED = "source map loaded: ";
const UNUSABLE = "source map ";

describe("Breakpoints resolving a file through a source map", () => {
  it("sets a breakpoint on a TypeScript line of tsc output with a map file, which pauses there", async () => {
    const compiled = writeCompiled(test.fixtures, "checkout");
    const module = test.fixtures.loadCheckout(compiled.script);

    test.apply({ id: "bp-1", file: compiled.file, line: 8 });
    await test.waitForLine("debug", LOADED);
    const total = module.total(TWO_ITEMS);

    expect({ sent: test.sent, total, pauses: test.session.pauses.length }).toEqual({
      sent: [status("bp-1", "pending"), status("bp-1", "active")],
      total: TOTAL_OF_TWO_ITEMS,
      pauses: 2,
    });
  });

  it("maps the line to the compiled script's URL, line and column", async () => {
    const compiled = writeCompiled(test.fixtures, "checkout");
    test.fixtures.loadCheckout(compiled.script);

    test.apply({ id: "bp-1", file: compiled.file, line: 8 });
    await test.waitForLine("debug", LOADED);

    expect(test.messagesAt("debug").filter((line) => line.startsWith("bp-1"))).toEqual([
      `bp-1 ${compiled.file}:8 → ${test.fixtures.urlOf(compiled.script)}:7:21`,
    ]);
  });

  it("maps a line without code to the next line that has some", async () => {
    const compiled = writeCompiled(test.fixtures, "checkout");
    test.fixtures.loadCheckout(compiled.script);

    test.apply({ id: "bp-1", file: compiled.file, line: 10 });
    await test.waitForLine("debug", LOADED);

    expect(test.messagesAt("debug").filter((line) => line.startsWith("bp-1"))).toEqual([
      `bp-1 ${compiled.file}:10 → ${test.fixtures.urlOf(compiled.script)}:9:5`,
    ]);
  });

  it("gives error when no line from the entry's on has code in the map", async () => {
    const compiled = writeCompiled(test.fixtures, "checkout");
    test.fixtures.loadCheckout(compiled.script);

    test.apply({ id: "bp-1", file: compiled.file, line: 40 });
    await test.waitForLine("debug", LOADED);

    expect({ sent: test.sent, set: test.session.count("Debugger.setBreakpointByUrl") }).toEqual({
      sent: [status("bp-1", "pending"), status("bp-1", "error", "no code at or after line 40")],
      set: 0,
    });
  });

  it("reads an inline map from its data: URL", async () => {
    const compiled = writeCompiled(test.fixtures, "checkout", { map: "inline" });
    const module = test.fixtures.loadCheckout(compiled.script);

    test.apply({ id: "bp-1", file: compiled.file, line: 8 });
    await test.waitForLine("debug", LOADED);
    module.total(TWO_ITEMS);

    expect({ sent: test.sent, pauses: test.session.pauses.length }).toEqual({
      sent: [status("bp-1", "pending"), status("bp-1", "active")],
      pauses: 2,
    });
  });

  it("resolves a pending entry when a script with its base name and a map loads", async () => {
    const compiled = writeCompiled(test.fixtures, "checkout");
    test.apply({ id: "bp-1", file: compiled.file, line: 8 });

    const module = test.fixtures.loadCheckout(compiled.script);
    await test.waitForLine("debug", LOADED);
    module.total(TWO_ITEMS);

    expect({ sent: test.sent, pauses: test.session.pauses.length }).toEqual({
      sent: [status("bp-1", "pending"), status("bp-1", "active")],
      pauses: 2,
    });
  });

  it("logs the map's URL, size and read time", async () => {
    const compiled = writeCompiled(test.fixtures, "checkout");
    test.fixtures.loadCheckout(compiled.script);

    test.apply({ id: "bp-1", file: compiled.file, line: 8 });
    await test.waitForLine("debug", LOADED);

    expect(test.messagesAt("debug").filter((line) => line.startsWith(LOADED))).toEqual([
      expect.stringMatching(
        new RegExp(
          `^source map loaded: \\S+\\.js\\.map of ${test.fixtures.urlOf(compiled.script)}, \\d+ bytes, \\d+ ms$`,
        ),
      ),
    ]);
  });

  it("reads a map once for the entries that need it", async () => {
    const compiled = writeCompiled(test.fixtures, "checkout");
    test.fixtures.loadCheckout(compiled.script);

    test.apply({ id: "bp-1", file: compiled.file, line: 8 }, { id: "bp-2", file: compiled.file, line: 11 });
    await test.waitForLine("debug", LOADED);

    expect({
      sent: test.sent,
      reads: test.messagesAt("debug").filter((line) => line.startsWith(LOADED)).length,
    }).toEqual({
      sent: [status("bp-1", "pending"), status("bp-2", "pending"), status("bp-1", "active"), status("bp-2", "active")],
      reads: 1,
    });
  });

  it("does not read the map again for a new entry while the script has a breakpoint", async () => {
    const compiled = writeCompiled(test.fixtures, "checkout");
    test.fixtures.loadCheckout(compiled.script);
    test.apply({ id: "bp-1", file: compiled.file, line: 8 });
    await test.waitForLine("debug", LOADED);

    test.apply({ id: "bp-1", file: compiled.file, line: 8 }, { id: "bp-2", file: compiled.file, line: 11 });

    expect(test.sent.slice(2)).toEqual([status("bp-1", "active"), status("bp-2", "active")]);
  });

  it("drops the decoded map with the script's last breakpoint and reads it again when it is needed", async () => {
    const compiled = writeCompiled(test.fixtures, "checkout");
    const other = test.fixtures.write("orders/invoice.cjs", CHECKOUT_SOURCE);
    test.fixtures.loadCheckout(compiled.script);
    test.fixtures.loadCheckout(other);
    test.apply({ id: "bp-1", file: compiled.file, line: 8 });
    await test.waitForLine("debug", LOADED);
    test.apply({ id: "bp-2", file: test.fixtures.file("orders/invoice.cjs"), line: 4 });

    test.apply(
      { id: "bp-2", file: test.fixtures.file("orders/invoice.cjs"), line: 4 },
      { id: "bp-3", file: compiled.file, line: 8 },
    );
    await test.waitForLine("debug", LOADED);

    expect({
      sent: test.sent.slice(3),
      reads: test.messagesAt("debug").filter((line) => line.startsWith(LOADED)).length,
    }).toEqual({ sent: [status("bp-2", "active"), status("bp-3", "pending"), status("bp-3", "active")], reads: 2 });
  });

  it("gives error with the reason and logs a warning for a broken map, and sets the other entries", async () => {
    const broken = writeCompiled(test.fixtures, "checkout");
    writeFileSync(broken.mapFile, "{ not json");
    const working = writeCompiled(test.fixtures, "invoice");
    test.fixtures.loadCheckout(broken.script);
    test.fixtures.loadCheckout(working.script);

    test.apply({ id: "bp-1", file: broken.file, line: 8 }, { id: "bp-2", file: working.file, line: 8 });
    await Promise.all([test.waitForLine("warn", UNUSABLE), test.waitForLine("debug", LOADED)]);

    expect({ sent: test.sent.slice(2), warnings: test.messagesAt("warn") }).toEqual({
      sent: expect.arrayContaining([
        status("bp-1", "error", "the source map is not valid JSON"),
        status("bp-2", "active"),
      ]) as unknown,
      warnings: [
        `source map ${broken.mapFile.split("/").at(-1) ?? ""} of ${test.fixtures.urlOf(broken.script)} cannot be used: the source map is not valid JSON`,
      ],
    });
  });

  it("gives error when the map file cannot be read", async () => {
    const compiled = writeCompiled(test.fixtures, "checkout");
    rmSync(compiled.mapFile);
    test.fixtures.loadCheckout(compiled.script);

    test.apply({ id: "bp-1", file: compiled.file, line: 8 });
    await test.waitForLine("warn", UNUSABLE);

    expect(test.sent.at(-1)).toEqual(status("bp-1", "error", "the source map file cannot be read"));
  });

  it("gives error for a map file over 8 MiB without reading it", async () => {
    const compiled = writeCompiled(test.fixtures, "checkout");
    truncateSync(compiled.mapFile, 8 * 1024 * 1024 + 1);
    test.fixtures.loadCheckout(compiled.script);

    test.apply({ id: "bp-1", file: compiled.file, line: 8 });
    await test.waitForLine("warn", UNUSABLE);

    expect(test.sent.at(-1)).toEqual(status("bp-1", "error", "the source map is larger than 8 MiB"));
  });

  it("gives error for a map URL with a scheme", async () => {
    const script = test.fixtures.write(
      "dist/checkout.js",
      `${CHECKOUT_SOURCE}//# sourceMappingURL=https://cdn.example.com/checkout.js.map\n`,
    );
    test.fixtures.loadCheckout(script);

    test.apply({ id: "bp-1", file: test.fixtures.file("src/checkout.ts"), line: 4 });
    await test.waitForLine("warn", UNUSABLE);

    expect(test.sent.at(-1)).toEqual(status("bp-1", "error", "the source map URL scheme is not supported"));
  });
});

describe("Breakpoints sharing and retrying through source maps", () => {
  it("shares one V8 breakpoint between entries that map to the same position", async () => {
    const compiled = writeCompiled(test.fixtures, "checkout");
    test.fixtures.loadCheckout(compiled.script);

    test.apply({ id: "bp-1", file: compiled.file, line: 10 }, { id: "bp-2", file: compiled.file, line: 11 });
    await test.waitForLine("debug", LOADED);

    expect({ sent: test.sent.slice(2), set: test.session.count("Debugger.setBreakpointByUrl") }).toEqual({
      sent: [status("bp-1", "active"), status("bp-2", "active")],
      set: 1,
    });
  });

  it("sets separate V8 breakpoints for lines that map to one generated line at other columns", async () => {
    const original = test.fixtures.file("src/pair.ts");
    // Generated line 1 holds two statements: original line 1 at column 2 and original line 2 at column 19
    const map = createSourceMapText(
      [`../${original}`],
      encodeMappings([
        [],
        [
          { column: 2, source: 0, line: 1, originalColumn: 0 },
          { column: 19, source: 0, line: 2, originalColumn: 0 },
        ],
      ]),
    );
    const script = test.fixtures.write(
      "dist/pair.js",
      `exports.pair = function pair() {
  const first = 1; const second = 2;
  return first + second;
};
//# sourceMappingURL=data:application/json;base64,${Buffer.from(map).toString("base64")}
`,
    );
    test.fixtures.loadPause(script);

    test.apply({ id: "bp-1", file: original, line: 2 }, { id: "bp-2", file: original, line: 3 });
    await test.waitForLine("debug", LOADED);

    expect({ sent: test.sent.slice(2), set: test.session.count("Debugger.setBreakpointByUrl") }).toEqual({
      sent: [status("bp-1", "active"), status("bp-2", "active")],
      set: 2,
    });
  });

  it("retries an entry that a failed map gave error when a script with its base name loads", async () => {
    const vendor = writeCompiled(test.fixtures, "checkout", { dir: "vendor" });
    writeFileSync(vendor.mapFile, "{ not json");
    const app = writeCompiled(test.fixtures, "checkout");
    test.fixtures.loadCheckout(vendor.script);
    test.apply({ id: "bp-1", file: app.file, line: 8 });
    await test.waitForLine("warn", UNUSABLE);

    test.fixtures.loadCheckout(app.script);
    await test.waitForLine("debug", LOADED);

    expect(test.sent).toEqual([
      status("bp-1", "pending"),
      status("bp-1", "error", "the source map is not valid JSON"),
      status("bp-1", "pending"),
      status("bp-1", "active"),
    ]);
  });
});

describe("Breakpoints when a map read ends late", () => {
  it("sends nothing after stop() for a read that was running", async () => {
    const compiled = writeCompiled(test.fixtures, "checkout");
    test.fixtures.loadCheckout(compiled.script);
    test.apply({ id: "bp-1", file: compiled.file, line: 8 });

    test.breakpoints.stop();
    await test.waitForLine("debug", "source map ");

    expect({ sent: test.sent, set: test.session.count("Debugger.setBreakpointByUrl") }).toEqual({
      sent: [status("bp-1", "pending")],
      set: 0,
    });
  });

  it("applies the read to the entry as it is listed when the read ends", async () => {
    const compiled = writeCompiled(test.fixtures, "checkout");
    test.fixtures.loadCheckout(compiled.script);
    test.apply({ id: "bp-1", file: compiled.file, line: 8 });

    test.apply({ id: "bp-1", file: compiled.file, line: 11 });
    await test.waitForLine("debug", LOADED);

    expect({
      sent: test.sent,
      placed: test.messagesAt("debug").filter((line) => line.startsWith("bp-1")),
    }).toEqual({
      sent: [status("bp-1", "pending"), status("bp-1", "pending"), status("bp-1", "active")],
      placed: [`bp-1 ${compiled.file}:11 → ${test.fixtures.urlOf(compiled.script)}:9:5`],
    });
  });

  it("forgets the maps when the domain turns off and reads them again for a later list", async () => {
    const compiled = writeCompiled(test.fixtures, "checkout");
    test.fixtures.loadCheckout(compiled.script);
    test.apply({ id: "bp-1", file: compiled.file, line: 8 });
    await test.waitForLine("debug", LOADED);
    test.apply();

    test.apply({ id: "bp-1", file: compiled.file, line: 8 });
    await test.waitForLine("debug", LOADED);

    expect({
      sent: test.sent.slice(2),
      reads: test.messagesAt("debug").filter((line) => line.startsWith(LOADED)).length,
    }).toEqual({ sent: [status("bp-1", "pending"), status("bp-1", "active")], reads: 2 });
  });

  it("ignores a read of a script loaded again meanwhile and reads the new one", async () => {
    const compiled = writeCompiled(test.fixtures, "checkout");
    test.fixtures.loadCheckout(compiled.script);
    test.apply({ id: "bp-1", file: compiled.file, line: 8 });

    test.fixtures.unload(compiled.script);
    test.fixtures.loadCheckout(compiled.script);
    await test.waitForLine("debug", LOADED);

    expect({
      sent: test.sent,
      ignored: test.messagesAt("debug").filter((line) => line.endsWith("ignored: its script record is gone")).length,
    }).toEqual({ sent: [status("bp-1", "pending"), status("bp-1", "active")], ignored: 1 });
  });

  it("ignores a read that ends after the domain turned off", async () => {
    const compiled = writeCompiled(test.fixtures, "checkout");
    test.fixtures.loadCheckout(compiled.script);
    test.apply({ id: "bp-1", file: compiled.file, line: 8 });

    test.apply();
    await test.waitForLine("debug", "source map ");

    expect({ sent: test.sent, set: test.session.count("Debugger.setBreakpointByUrl") }).toEqual({
      sent: [status("bp-1", "pending")],
      set: 0,
    });
  });

  it("does not set an entry that was removed while its map was read", async () => {
    const compiled = writeCompiled(test.fixtures, "checkout");
    const other = test.fixtures.write("orders/invoice.cjs", CHECKOUT_SOURCE);
    test.fixtures.loadCheckout(compiled.script);
    test.fixtures.loadCheckout(other);
    test.apply({ id: "bp-1", file: compiled.file, line: 8 });

    test.apply({ id: "bp-2", file: test.fixtures.file("orders/invoice.cjs"), line: 4 });
    await test.waitForLine("debug", LOADED);

    expect({ sent: test.sent, set: test.session.count("Debugger.setBreakpointByUrl") }).toEqual({
      sent: [status("bp-1", "pending"), status("bp-2", "active")],
      set: 1,
    });
  });
});
