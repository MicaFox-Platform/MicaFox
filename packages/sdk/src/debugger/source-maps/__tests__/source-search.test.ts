import { describe, expect, it } from "vitest";

import type { MapSource } from "../map-sources.js";
import { MAX_SEARCHED_SOURCES, SourceSearch } from "../source-search.js";

interface Script {
  readonly url: string;
}

const source = (path: string): MapSource => {
  const segments = path.split("/").filter((segment) => segment !== "");
  return { source: path, path, segments, isDependency: segments.includes("node_modules") };
};

// Sources with distinct file names, so a test can fill the search past its limit
const manySources = (prefix: string, count: number): MapSource[] =>
  Array.from({ length: count }, (_unused, index) => source(`/app/${prefix}/file-${String(index)}.ts`));

const urlsFound = (search: SourceSearch<Script>, fileName: string): string[] =>
  search.find(fileName).map(({ script }) => script.url);

describe("SourceSearch", () => {
  it("finds the kept sources by file name, never one under node_modules", () => {
    const search = new SourceSearch<Script>();
    const server = { url: "file:///app/dist/server.cjs" };

    search.keep(server, [source("/app/src/checkout.ts"), undefined, source("/app/node_modules/lib/checkout.ts")]);

    expect(search.find("checkout.ts")).toEqual([{ script: server, source: source("/app/src/checkout.ts") }]);
  });

  it("tells a record unsearched, searching, then searched, and a new record of the URL unsearched", () => {
    const search = new SourceSearch<Script>();
    const server = { url: "file:///app/dist/server.cjs" };
    const before = search.view(server);
    search.start(server);
    const during = search.view(server);

    const isLast = search.keep(server, []);

    expect({ before, during, isLast, after: search.view(server), replaced: search.view({ ...server }) }).toEqual({
      before: "unsearched",
      during: "searching",
      isLast: true,
      after: "searched",
      replaced: "unsearched",
    });
  });

  it("ends the search only with the last record pending", () => {
    const search = new SourceSearch<Script>();
    const first = { url: "file:///app/dist/first.cjs" };
    const second = { url: "file:///app/dist/second.cjs" };
    search.start(first);
    search.start(second);

    const afterFirst = search.fail(first, undefined);
    const afterSecond = search.keep(second, []);

    expect({ afterFirst, afterSecond, isSearching: search.isSearching() }).toEqual({
      afterFirst: false,
      afterSecond: true,
      isSearching: false,
    });
  });

  it("gives the reason of the first map over a limit", () => {
    const search = new SourceSearch<Script>();
    const runtime = { url: "file:///app/dist/runtime.js" };
    const huge = { url: "file:///app/dist/huge.cjs" };
    search.start(runtime);
    search.start(huge);

    search.fail(runtime, undefined);
    search.fail(huge, "the source map is larger than 8 MiB");

    expect(search.failure()).toBe("the source map is larger than 8 MiB");
  });

  it("drops the oldest record's sources past 100,000 and does not search that record again", () => {
    const search = new SourceSearch<Script>();
    const oldest = { url: "file:///app/dist/oldest.cjs" };
    const middle = { url: "file:///app/dist/middle.cjs" };
    const newest = { url: "file:///app/dist/newest.cjs" };
    search.keep(oldest, manySources("oldest", 40_000));
    search.keep(middle, manySources("middle", 40_000));

    search.keep(newest, manySources("newest", MAX_SEARCHED_SOURCES - 70_000));

    expect({
      oldest: urlsFound(search, "file-0.ts"),
      view: search.view(oldest),
    }).toEqual({ oldest: [middle.url, newest.url], view: "searched" });
  });

  it("forgets a record's sources, ends its pending search and starts empty after clear", () => {
    const search = new SourceSearch<Script>();
    const server = { url: "file:///app/dist/server.cjs" };
    const chunk = { url: "file:///app/dist/chunk.js" };
    search.keep(server, [source("/app/src/checkout.ts")]);
    search.start(chunk);

    const forgotten = { server: search.forget(server.url), chunk: search.forget(chunk.url) };
    const found = urlsFound(search, "checkout.ts");
    search.keep(server, [source("/app/src/checkout.ts")]);
    search.clear();

    expect({ forgotten, found, afterClear: urlsFound(search, "checkout.ts") }).toEqual({
      forgotten: { server: false, chunk: true },
      found: [],
      afterClear: [],
    });
  });
});
