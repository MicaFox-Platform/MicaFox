import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import { createRecordingLogger, type LoggedLine } from "../../../../test/debugger/fakes.js";
import { createSourceMapText, encodeMappings } from "../../../../test/source-maps/encode-mappings.js";
import { createLogger } from "../../../logger/index.js";
import { SourceMaps, type MappedScript } from "../index.js";

const MAP_TEXT = createSourceMapText(
  ["checkout.ts"],
  encodeMappings([[{ column: 2, source: 0, line: 3, originalColumn: 0 }]]),
);

const toDataUrl = (text: string): string => `data:application/json;base64,${Buffer.from(text).toString("base64")}`;

const script = (sourceMapUrl = toDataUrl(MAP_TEXT)): MappedScript => ({
  url: "file:///app/src/checkout.js",
  sourceMapUrl,
});

const createSourceMaps = (onRead: (read: MappedScript) => void = () => undefined) => {
  const lines: LoggedLine[] = [];
  const waiters: Array<{ prefix: string; resolve: () => void }> = [];
  const logger = createLogger({
    component: "debugger",
    env: {},
    console: createRecordingLogger(lines, (line) => {
      for (const waiter of waiters.filter(({ prefix }) => line.message.startsWith(prefix))) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }),
  });
  logger.set({ logLevel: "debug" }, "debugger");
  const reads: MappedScript[] = [];
  const failures: unknown[] = [];
  const maps = new SourceMaps<MappedScript>({
    logger,
    onRead: (read) => {
      reads.push(read);
      onRead(read);
    },
    fail: (error) => {
      failures.push(error);
    },
  });

  return {
    maps,
    reads,
    failures,
    messages: (prefix: string) => lines.map((line) => line.message).filter((message) => message.startsWith(prefix)),
    /** Resolves after the line starting with `prefix` is logged and the call that logged it returns. */
    logged: (prefix: string) =>
      new Promise<void>((resolve) => {
        waiters.push({ prefix, resolve });
      }),
  };
};

describe("SourceMaps reading", () => {
  it("starts with an unread map and is reading until the read ends", () => {
    const test = createSourceMaps();
    const checkout = script();
    const before = test.maps.view(checkout);

    test.maps.load(checkout);

    expect({ before, during: test.maps.view(checkout) }).toEqual({
      before: { kind: "unread" },
      during: { kind: "reading" },
    });
  });

  it("gives the resolved sources and the index when the read ends, and calls onRead", async () => {
    const test = createSourceMaps();
    const checkout = script();

    test.maps.load(checkout);
    await test.logged("source map loaded");

    expect({ view: test.maps.view(checkout), reads: test.reads }).toEqual({
      view: {
        kind: "read",
        sources: [{ source: "checkout.ts", segments: ["app", "src", "checkout.ts"] }],
        index: expect.anything() as unknown,
      },
      reads: [checkout],
    });
  });

  it("reads a map once for overlapping loads", async () => {
    const test = createSourceMaps();
    const checkout = script();

    test.maps.load(checkout);
    test.maps.load(checkout);
    await test.logged("source map loaded");

    expect({ loaded: test.messages("source map loaded").length, reads: test.reads.length }).toEqual({
      loaded: 1,
      reads: 1,
    });
  });

  it("logs the map, its size and the time the read took", async () => {
    const test = createSourceMaps();

    test.maps.load(script());
    await test.logged("source map loaded");

    expect(test.messages("source map loaded")).toEqual([
      expect.stringMatching(
        new RegExp(
          `^source map loaded: inline in file:///app/src/checkout.js, ${String(MAP_TEXT.length)} bytes, \\d+ ms$`,
        ),
      ),
    ]);
  });

  it("gives the reason of a map that cannot be used and logs a warning", async () => {
    const test = createSourceMaps();
    const checkout = script(toDataUrl("{ not json"));

    test.maps.load(checkout);
    await test.logged("source map inline");

    expect({ view: test.maps.view(checkout), warnings: test.messages("source map inline") }).toEqual({
      view: { kind: "failed", reason: "the source map is not valid JSON" },
      warnings: ["source map inline in file:///app/src/checkout.js cannot be used: the source map is not valid JSON"],
    });
  });

  it("does not read a map that failed again", async () => {
    const test = createSourceMaps();
    const checkout = script(toDataUrl("{ not json"));
    test.maps.load(checkout);
    await test.logged("source map inline");

    test.maps.load(checkout);

    expect(test.maps.view(checkout).kind).toBe("failed");
  });

  it("treats a new record with the URL of a read one as unread", async () => {
    const test = createSourceMaps();
    test.maps.load(script());
    await test.logged("source map loaded");

    expect(test.maps.view(script())).toEqual({ kind: "unread" });
  });

  it("ignores a read that ends after clear()", async () => {
    const test = createSourceMaps();
    const checkout = script();
    test.maps.load(checkout);

    test.maps.clear();
    await test.logged("source map inline");

    expect({
      view: test.maps.view(checkout),
      reads: test.reads,
      ignored: test.messages("source map inline"),
    }).toEqual({
      view: { kind: "unread" },
      reads: [],
      ignored: ["source map inline in file:///app/src/checkout.js ignored: its script record is gone"],
    });
  });

  it("reads one map at a time and skips a queued one whose script was recorded again", async () => {
    const test = createSourceMaps();
    const first = script();
    const second = { url: "file:///app/src/invoice.js", sourceMapUrl: toDataUrl(MAP_TEXT) };
    test.maps.load(first);
    test.maps.load(second);

    test.maps.forget(second.url);
    await test.logged("source map loaded");

    expect({ reads: test.reads, lines: test.messages("source map") }).toEqual({
      reads: [first],
      lines: [expect.stringMatching(/^source map loaded: inline in file:\/\/\/app\/src\/checkout\.js/)],
    });
  });

  it("ignores a running read of a script recorded again", async () => {
    const test = createSourceMaps();
    const checkout = script();
    test.maps.load(checkout);

    test.maps.forget(checkout.url);
    await test.logged("source map inline");

    expect({ view: test.maps.view(checkout), reads: test.reads }).toEqual({ view: { kind: "unread" }, reads: [] });
  });

  it("reports an error thrown while the read ends as a failure", async () => {
    const test = createSourceMaps(() => {
      throw new Error("onRead failed");
    });

    test.maps.load(script());
    await test.logged("source map loaded");

    expect(test.failures).toEqual([new Error("onRead failed")]);
  });
});

describe("SourceMaps keeping the index", () => {
  it("drops the index of a map no entry holds and keeps its sources", async () => {
    const test = createSourceMaps();
    const checkout = script();
    test.maps.load(checkout);
    await test.logged("source map loaded");

    test.maps.trim(checkout);

    expect(test.maps.view(checkout)).toEqual({
      kind: "read",
      sources: [{ source: "checkout.ts", segments: ["app", "src", "checkout.ts"] }],
    });
  });

  it("keeps the index while an entry holds the script", async () => {
    const test = createSourceMaps();
    const checkout = script();
    test.maps.load(checkout);
    await test.logged("source map loaded");

    test.maps.hold(checkout, "bp-1");
    test.maps.trim(checkout);

    expect(test.maps.view(checkout)).toHaveProperty("index");
  });

  it("drops the index with the last entry that held it", async () => {
    const test = createSourceMaps();
    const checkout = script();
    test.maps.load(checkout);
    await test.logged("source map loaded");
    test.maps.hold(checkout, "bp-1");
    test.maps.hold(checkout, "bp-2");

    test.maps.release(checkout.url, "bp-1");
    const afterFirst = test.maps.view(checkout);
    test.maps.release(checkout.url, "bp-2");

    expect({ afterFirst: "index" in afterFirst, afterLast: "index" in test.maps.view(checkout) }).toEqual({
      afterFirst: true,
      afterLast: false,
    });
  });

  it("reads the map again to bring back a dropped index", async () => {
    const test = createSourceMaps();
    const checkout = script();
    test.maps.load(checkout);
    await test.logged("source map loaded");
    test.maps.trim(checkout);

    test.maps.load(checkout);
    await test.logged("source map loaded");

    expect({
      loaded: test.messages("source map loaded").length,
      hasIndex: "index" in test.maps.view(checkout),
    }).toEqual({ loaded: 2, hasIndex: true });
  });

  it("does not read a map whose index is kept again", async () => {
    const test = createSourceMaps();
    const checkout = script();
    test.maps.load(checkout);
    await test.logged("source map loaded");

    test.maps.load(checkout);

    expect(test.maps.view(checkout).kind).toBe("read");
  });
});
