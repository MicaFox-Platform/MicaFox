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

const CHECKOUT_SOURCE = {
  source: "checkout.ts",
  path: "/app/src/checkout.ts",
  segments: ["app", "src", "checkout.ts"],
  isDependency: false,
};

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
  let searchesEnded = 0;
  const maps = new SourceMaps<MappedScript>({
    logger,
    onRead: (read) => {
      reads.push(read);
      onRead(read);
    },
    onSearched: () => {
      searchesEnded += 1;
    },
    fail: (error) => {
      failures.push(error);
    },
  });

  return {
    maps,
    reads,
    failures,
    searchesEnded: () => searchesEnded,
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
        sources: [CHECKOUT_SOURCE],
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

    test.maps.trimUnheld();

    expect(test.maps.view(checkout)).toEqual({
      kind: "read",
      sources: [CHECKOUT_SOURCE],
    });
  });

  it("keeps the index while an entry holds the script", async () => {
    const test = createSourceMaps();
    const checkout = script();
    test.maps.load(checkout);
    await test.logged("source map loaded");

    test.maps.hold(checkout, "bp-1");
    test.maps.trimUnheld();

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
    test.maps.trimUnheld();

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

const BUNDLE_TEXT = createSourceMapText(
  ["../src/checkout.ts", "../node_modules/lib/index.js", "../src/cart.ts"],
  encodeMappings([[{ column: 2, source: 0, line: 3, originalColumn: 0 }]]),
);

const bundle = (name: string, text = BUNDLE_TEXT): MappedScript => ({
  url: `file:///app/dist/${name}`,
  sourceMapUrl: toDataUrl(text),
});

const pathsFound = (test: ReturnType<typeof createSourceMaps>, fileName: string): string[] =>
  test.maps.findSearched(fileName).map(({ script: found, source }) => `${found.url} ${source.path}`);

describe("SourceMaps searching the bundles", () => {
  it("keeps only the sources of a searched map outside node_modules, without an index, and ends the search", async () => {
    const test = createSourceMaps();
    const server = bundle("server.cjs");

    test.maps.searchMap(server);
    const during = { view: test.maps.searchView(server), isSearching: test.maps.isSearching() };
    await test.logged("bundles searched");

    expect({
      during,
      after: test.maps.searchView(server),
      checkout: pathsFound(test, "checkout.ts"),
      dependency: pathsFound(test, "index.js"),
      byName: test.maps.view(server),
      searchesEnded: test.searchesEnded(),
    }).toEqual({
      during: { view: "searching", isSearching: true },
      after: "searched",
      checkout: ["file:///app/dist/server.cjs /app/src/checkout.ts"],
      dependency: [],
      byName: { kind: "unread" },
      searchesEnded: 1,
    });
  });

  it("reads every map by name before any map for a search", async () => {
    const test = createSourceMaps();
    test.maps.searchMap(bundle("first.cjs"));
    test.maps.searchMap(bundle("second.cjs"));

    test.maps.load(script());
    await test.logged("bundles searched");

    expect(
      test.messages("source map").map((message) => /^source map (\w+): inline in (\S+),/.exec(message)?.slice(1)),
    ).toEqual([
      ["searched", "file:///app/dist/first.cjs"],
      ["loaded", "file:///app/src/checkout.js"],
      ["searched", "file:///app/dist/second.cjs"],
    ]);
  });

  it("reads a map once for overlapping searches", async () => {
    const test = createSourceMaps();
    const server = bundle("server.cjs");

    test.maps.searchMap(server);
    test.maps.searchMap(server);
    await test.logged("bundles searched");

    expect(test.messages("source map searched")).toHaveLength(1);
  });

  it("logs a map over a limit as a warning and gives its reason to the search", async () => {
    const test = createSourceMaps();
    const tooMany = `{"version":3,"sources":[],"mappings":"","names":[${"0,".repeat(50_000)}0]}`;

    test.maps.searchMap(bundle("huge.cjs", tooMany));
    await test.logged("bundles searched");

    expect({ warned: test.messages("source map inline"), failure: test.maps.searchFailure() }).toEqual({
      warned: [
        "source map inline in file:///app/dist/huge.cjs cannot be searched: the source map has more than 50,000 JSON values",
      ],
      failure: "the source map has more than 50,000 JSON values",
    });
  });

  it("logs any other failure of a search, such as an index map, at debug and gives no reason", async () => {
    const test = createSourceMaps();
    const runtime = bundle("runtime.js", JSON.stringify({ version: 3, sections: [] }));

    test.maps.searchMap(runtime);
    await test.logged("bundles searched");

    expect({ view: test.maps.searchView(runtime), failure: test.maps.searchFailure() }).toEqual({
      view: "searched",
      failure: undefined,
    });
  });

  it("uses the sources of a map read by name without reading it again", async () => {
    const test = createSourceMaps();
    const server = bundle("server.cjs");
    test.maps.load(server);
    await test.logged("source map loaded");

    test.maps.searchMap(server);

    expect({
      view: test.maps.searchView(server),
      isSearching: test.maps.isSearching(),
      checkout: pathsFound(test, "checkout.ts"),
      searched: test.messages("source map searched"),
    }).toEqual({
      view: "searched",
      isSearching: false,
      checkout: ["file:///app/dist/server.cjs /app/src/checkout.ts"],
      searched: [],
    });
  });

  it("lets a read by name under way end the search of the same map", async () => {
    const test = createSourceMaps();
    const server = bundle("server.cjs");
    test.maps.load(server);

    test.maps.searchMap(server);
    await test.logged("bundles searched");

    expect({
      loaded: test.messages("source map loaded").length,
      searched: test.messages("source map searched").length,
      checkout: pathsFound(test, "checkout.ts"),
    }).toEqual({ loaded: 1, searched: 0, checkout: ["file:///app/dist/server.cjs /app/src/checkout.ts"] });
  });

  it("ends the search with a debug line when the map file of a search read is missing", async () => {
    const test = createSourceMaps();
    const missing: MappedScript = { url: "file:///app/dist/missing.cjs", sourceMapUrl: "missing.cjs.map" };

    test.maps.searchMap(missing);
    await test.logged("bundles searched");

    expect({
      failures: test.failures,
      view: test.maps.searchView(missing),
      failure: test.maps.searchFailure(),
      searchesEnded: test.searchesEnded(),
      debug: test.messages("source map"),
    }).toEqual({
      failures: [],
      view: "searched",
      failure: undefined,
      searchesEnded: 1,
      debug: [expect.stringContaining("cannot be searched")],
    });
  });

  it("ignores the result of a search read that ends after clear()", async () => {
    const test = createSourceMaps();
    const server = bundle("server.cjs");
    test.maps.searchMap(server);

    test.maps.clear();
    await test.logged("source map inline");

    expect({ checkout: pathsFound(test, "checkout.ts"), searchesEnded: test.searchesEnded() }).toEqual({
      checkout: [],
      searchesEnded: 0,
    });
  });

  it("ends the search when the last record searched is recorded again", () => {
    const test = createSourceMaps();
    const server = bundle("server.cjs");
    test.maps.searchMap(server);

    test.maps.forget(server.url);

    expect({ isSearching: test.maps.isSearching(), searchesEnded: test.searchesEnded() }).toEqual({
      isSearching: false,
      searchesEnded: 1,
    });
  });
});

describe("SourceMaps holding indexes", () => {
  // Decoding 1,500,000 segments takes about a second, more under coverage; Vitest waits five seconds by default
  const TIMEOUT_MS = 60_000;
  const LARGEST = createSourceMapText(["checkout.ts"], "AAAA,".repeat(1_500_000));

  it(
    "holds the indexes of maps up to 3,000,000 segments in all, each map counted once",
    { timeout: TIMEOUT_MS },
    async () => {
      const test = createSourceMaps();
      const first = bundle("first.cjs", LARGEST);
      const second = bundle("second.cjs", LARGEST);
      const small = bundle("small.cjs");
      for (const each of [first, second, small]) {
        test.maps.load(each);
      }

      await test.logged("source map loaded: inline in file:///app/dist/small.cjs");
      test.maps.hold(first, "bp-1");
      test.maps.hold(second, "bp-2");

      const again = test.maps.canHold([first, second]);
      const more = test.maps.canHold([small]);
      test.maps.release(second.url, "bp-2");

      expect({ again, more, afterRelease: test.maps.canHold([small]) }).toEqual({
        again: true,
        more: false,
        afterRelease: true,
      });
    },
  );
});
