import type { BreakpointStatus } from "@micafox/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CART_MODULE, CHECKOUT_MODULE, writeBundle } from "../../../../test/debugger/bundled.js";
import {
  CHECKOUT_SOURCE,
  createBreakpoints,
  TOTAL_OF_TWO_ITEMS,
  TWO_ITEMS,
  type BreakpointsUnderTest,
} from "../../../../test/debugger/real-v8.js";

let test: BreakpointsUnderTest;

beforeEach(() => {
  // The harness charges the pause budget on Date.now(): a frozen clock keeps a pause slowed by a busy runner from spending it
  vi.useFakeTimers({ toFake: ["Date"] });
  test = createBreakpoints();
});

afterEach(() => {
  test.dispose();
  vi.useRealTimers();
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
const SEARCHED = "bundles searched";

/** The modules of a bundle in `dist/`, as its map names them: `../src/<name>-<tag>.ts`. */
const modulesOf = (...names: ReadonlyArray<[name: string, code: string]>) =>
  names.map(([name, code]) => ({ source: `../${test.fixtures.file(`src/${name}.ts`)}`, code }));

const writeServer = (relative = "dist/server.cjs") =>
  writeBundle(test.fixtures, relative, {
    modules: modulesOf(["cart", CART_MODULE], ["checkout", CHECKOUT_MODULE]),
  });

describe("Breakpoints in a bundle", () => {
  it("sets a breakpoint on a source of a bundle whose name differs, and shows the original line on top", async () => {
    const module = test.fixtures.loadCheckout(writeServer().script);

    test.apply({ id: "bp-1", file: test.fixtures.file("src/checkout.ts"), line: 4 });
    await test.waitForLine("debug", LOADED);
    const total = module.total(TWO_ITEMS);
    const top = test.snapshots[0]?.stack[0];

    expect({
      sent: test.sent,
      total,
      pauses: test.session.pauses.length,
      top: { isOriginal: top?.file.endsWith(`/${test.fixtures.file("src/checkout.ts")}`), line: top?.line },
    }).toEqual({
      sent: [status("bp-1", "pending"), status("bp-1", "active")],
      total: TOTAL_OF_TWO_ITEMS,
      pauses: 2,
      top: { isOriginal: true, line: 4 },
    });
  });

  it("resolves each source of one bundle, reading its map once by name", async () => {
    test.fixtures.loadCheckout(writeServer().script);

    test.apply(
      { id: "bp-1", file: test.fixtures.file("src/cart.ts"), line: 2 },
      { id: "bp-2", file: test.fixtures.file("src/checkout.ts"), line: 4 },
    );
    await test.waitForLine("debug", LOADED);

    expect({
      sent: test.sent.slice(2),
      reads: test.messagesAt("debug").filter((line) => line.startsWith(LOADED)).length,
    }).toEqual({ sent: [status("bp-1", "active"), status("bp-2", "active")], reads: 1 });
  });

  it("gives error when two different sources of one bundle with the entry's file name match as well", async () => {
    const bundle = writeBundle(test.fixtures, "dist/server.cjs", {
      modules: [
        { source: `../${test.fixtures.file("orders/checkout.ts")}`, code: CHECKOUT_MODULE },
        { source: `../${test.fixtures.file("billing/checkout.ts")}`, code: CHECKOUT_MODULE },
      ],
    });
    test.fixtures.loadCheckout(bundle.script);

    test.apply({ id: "bp-1", file: test.fixtures.file("lib/checkout.ts"), line: 4 });
    await test.waitForLine("debug", SEARCHED);

    expect(test.sent).toEqual([status("bp-1", "pending"), status("bp-1", "error", "file matches several files")]);
  });

  it("never resolves to a source under node_modules", async () => {
    const bundle = writeBundle(test.fixtures, "dist/server.cjs", {
      modules: [{ source: `../node_modules/${test.fixtures.file("lib/src/checkout.ts")}`, code: CHECKOUT_MODULE }],
    });
    test.fixtures.loadCheckout(bundle.script);

    test.apply({ id: "bp-1", file: test.fixtures.file("src/checkout.ts"), line: 4 });
    await test.waitForLine("debug", SEARCHED);

    expect(test.sent).toEqual([status("bp-1", "pending")]);
  });

  it("stays pending when no bundle's map lists the file, and a bundle without a map is never read", async () => {
    const unmapped = test.fixtures.write("dist/vendor.cjs", CHECKOUT_SOURCE);
    test.fixtures.loadCheckout(unmapped);
    test.fixtures.loadCheckout(writeServer().script);

    test.apply({ id: "bp-1", file: test.fixtures.file("src/invoice.ts"), line: 4 });
    await test.waitForLine("debug", SEARCHED);

    expect({
      sent: test.sent,
      read: test.messagesAt("debug").filter((line) => line.includes(test.fixtures.urlOf(unmapped))),
    }).toEqual({ sent: [status("bp-1", "pending")], read: [] });
  });

  it("reads no map of a bundle that loads while no entry searches the bundles", () => {
    const plain = test.fixtures.write("orders/checkout.cjs", CHECKOUT_SOURCE);
    test.fixtures.loadCheckout(plain);
    test.apply({ id: "bp-1", file: test.fixtures.file("orders/checkout.cjs"), line: 4 });

    test.fixtures.loadCheckout(writeServer().script);

    expect({
      sent: test.sent,
      reads: test.messagesAt("debug").filter((line) => line.startsWith("source map")),
    }).toEqual({ sent: [status("bp-1", "active")], reads: [] });
  });
});

describe("Breakpoints in chunks of a bundle", () => {
  it("sets the entry in a chunk that loads later and holds the winning path", async () => {
    const first = test.fixtures.loadCheckout(writeServer("dist/chunks/first.cjs").script);
    test.apply({ id: "bp-1", file: test.fixtures.file("src/checkout.ts"), line: 4 });
    await test.waitForLine("debug", LOADED);

    const later = test.fixtures.loadCheckout(writeServer("dist/chunks/later.cjs").script);
    await test.waitForLine("debug", LOADED);
    first.total(TWO_ITEMS);
    const firstPauses = test.session.pauses.length;
    later.total(TWO_ITEMS);

    expect({
      sent: test.sent,
      firstPauses,
      laterPauses: test.session.pauses.length - firstPauses,
      set: test.session.count("Debugger.setBreakpointByUrl"),
    }).toEqual({ sent: [status("bp-1", "pending"), status("bp-1", "active")], firstPauses: 2, laterPauses: 2, set: 2 });
  });

  it("reads each of two chunks loaded before the entry once and sets the entry in both", async () => {
    const first = test.fixtures.loadCheckout(writeServer("dist/chunks/first.cjs").script);
    const second = test.fixtures.loadCheckout(writeServer("dist/chunks/second.cjs").script);

    test.apply({ id: "bp-1", file: test.fixtures.file("src/checkout.ts"), line: 4 });
    await vi.waitFor(() => {
      expect(test.sent.at(-1)?.status).toBe("active");
    });
    first.total(TWO_ITEMS);
    second.total(TWO_ITEMS);

    expect({
      sent: test.sent,
      loaded: test.messagesAt("debug").filter((line) => line.startsWith(LOADED)).length,
      pauses: test.session.pauses.length,
    }).toEqual({ sent: [status("bp-1", "pending"), status("bp-1", "active")], loaded: 2, pauses: 4 });
  });

  it("does not read again a chunk that holds the winning path but has no code at the line", async () => {
    test.fixtures.loadCheckout(writeServer("dist/chunks/first.cjs").script);
    test.apply({ id: "bp-1", file: test.fixtures.file("src/checkout.ts"), line: 4 });
    await test.waitForLine("debug", LOADED);

    const short = writeBundle(test.fixtures, "dist/chunks/short.cjs", {
      modules: modulesOf(["checkout", "function total() {\n  return 0;\n}\n"]),
    });
    test.fixtures.loadCheckout(short.script);
    await test.waitForLine("debug", LOADED);
    const other = writeBundle(test.fixtures, "dist/chunks/other.cjs", { modules: modulesOf(["cart", CART_MODULE]) });
    test.fixtures.loadCheckout(other.script);
    await test.waitForLine("debug", SEARCHED);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(test.messagesAt("debug").filter((line) => line.startsWith(LOADED)).length).toBe(2);
  });

  it("logs the index map of a bundler's runtime at debug and resolves the entry in the other chunk", async () => {
    const runtime = writeBundle(test.fixtures, "dist/runtime.js", {
      modules: [],
      mapText: JSON.stringify({ version: 3, sections: [] }),
    });
    test.fixtures.loadPause(runtime.script);
    test.fixtures.loadCheckout(writeServer().script);

    test.apply({ id: "bp-1", file: test.fixtures.file("src/checkout.ts"), line: 4 });
    await test.waitForLine("debug", LOADED);

    expect({
      sent: test.sent,
      warnings: test.messagesAt("warn"),
      debug: test
        .messagesAt("debug")
        .filter((line) => line.endsWith("cannot be searched: index maps are not supported")),
    }).toEqual({
      sent: [status("bp-1", "pending"), status("bp-1", "active")],
      warnings: [],
      debug: [expect.stringContaining(test.fixtures.urlOf(runtime.script))],
    });
  });

  it("gives the reason of a bundle's map over a limit when nothing else matches", async () => {
    const tooMany = `{"version":3,"sources":[],"mappings":"","names":[${"0,".repeat(50_000)}0]}`;
    const huge = writeBundle(test.fixtures, "dist/huge.cjs", { modules: [], mapText: tooMany });
    test.fixtures.loadPause(huge.script);

    test.apply({ id: "bp-1", file: test.fixtures.file("src/checkout.ts"), line: 4 });
    await test.waitForLine("debug", SEARCHED);

    expect({ sent: test.sent, warned: test.messagesAt("warn").length }).toEqual({
      sent: [status("bp-1", "pending"), status("bp-1", "error", "the source map has more than 50,000 JSON values")],
      warned: 1,
    });
  });

  it("sets the entry again in a bundle loaded again under its URL", async () => {
    const server = writeServer();
    test.fixtures.loadCheckout(server.script);
    test.apply({ id: "bp-1", file: test.fixtures.file("src/checkout.ts"), line: 4 });
    await test.waitForLine("debug", LOADED);

    test.fixtures.unload(server.script);
    const reloaded = test.fixtures.loadCheckout(server.script);
    await test.waitForLine("debug", LOADED);
    reloaded.total(TWO_ITEMS);

    expect({ sent: test.sent, pauses: test.session.pauses.length }).toEqual({
      sent: [status("bp-1", "pending"), status("bp-1", "active"), status("bp-1", "pending"), status("bp-1", "active")],
      pauses: 2,
    });
  });
});

describe("Breakpoints set through a search while rate-limited", () => {
  it("sets the entry in a chunk loaded while its own bucket was off, once it is restored", async () => {
    test.fixtures.loadCheckout(writeServer("dist/chunks/first.cjs").script);
    test.apply({ id: "bp-1", file: test.fixtures.file("src/checkout.ts"), line: 4 });
    await test.waitForLine("debug", LOADED);
    test.breakpoints.rateLimit(["bp-1"]);

    const searched = test.waitForLine("debug", SEARCHED);
    const later = test.fixtures.loadCheckout(writeServer("dist/chunks/later.cjs").script);
    await searched;
    const loaded = test.waitForLine("debug", LOADED);
    test.breakpoints.restore(["bp-1"], "entries");
    await loaded;
    later.total(TWO_ITEMS);

    expect(test.session.pauses.length).toBe(2);
  });

  it("sets the entry in a chunk loaded while every breakpoint is off", async () => {
    test.fixtures.loadCheckout(writeServer("dist/chunks/first.cjs").script);
    test.apply({ id: "bp-1", file: test.fixtures.file("src/checkout.ts"), line: 4 });
    await test.waitForLine("debug", LOADED);
    test.breakpoints.rateLimitAll();
    const setBefore = test.session.count("Debugger.setBreakpointByUrl");

    const loaded = test.waitForLine("debug", LOADED);
    test.fixtures.loadCheckout(writeServer("dist/chunks/later.cjs").script);
    await loaded;

    expect(test.session.count("Debugger.setBreakpointByUrl")).toBe(setBefore + 1);
  });
});

describe("Breakpoints removed while their search runs", () => {
  it("sets no V8 breakpoint for an entry removed from the list and still resolves a later one by name", async () => {
    test.fixtures.loadCheckout(test.fixtures.write("orders/invoice.cjs", CHECKOUT_SOURCE));
    test.fixtures.loadCheckout(writeServer().script);
    const searched = test.waitForLine("debug", SEARCHED);
    test.apply({ id: "bp-1", file: test.fixtures.file("src/checkout.ts"), line: 4 });

    test.apply({ id: "bp-2", file: test.fixtures.file("orders/invoice.cjs"), line: 4 });
    await searched;

    expect({ sent: test.sent, set: test.session.count("Debugger.setBreakpointByUrl") }).toEqual({
      sent: [status("bp-1", "pending"), status("bp-2", "active")],
      set: 1,
    });
  });
});

describe("Breakpoints set in two chunks", () => {
  it("keeps the entry active when one chunk is loaded again, and it still pauses in the other", async () => {
    const first = test.fixtures.loadCheckout(writeServer("dist/chunks/first.cjs").script);
    test.apply({ id: "bp-1", file: test.fixtures.file("src/checkout.ts"), line: 4 });
    await test.waitForLine("debug", LOADED);
    const later = writeServer("dist/chunks/later.cjs");
    test.fixtures.loadCheckout(later.script);
    await test.waitForLine("debug", LOADED);

    test.fixtures.unload(later.script);
    test.fixtures.loadCheckout(later.script);
    await test.waitForLine("debug", LOADED);
    first.total(TWO_ITEMS);

    expect({ sent: test.sent, pauses: test.session.pauses.length }).toEqual({
      sent: [status("bp-1", "pending"), status("bp-1", "active")],
      pauses: 2,
    });
  });
});
