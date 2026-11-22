import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { PROBLEMS } from "../../src/server/app/problem/index.js";

const HTTP_DOC = path.resolve(import.meta.dirname, "../../../../docs/api/hub/http.md");

// The paragraph that lists the problem types: "`validation` (400), `unauthenticated`, `session-expired` … (401), …"
const documentedProblems = (): Record<string, number> => {
  const doc = readFileSync(HTTP_DOC, "utf8");
  const start = doc.indexOf("`type` never changes once released:");
  // The list wraps across lines, so one name and its status may sit on different lines
  const paragraph = doc.slice(start, doc.indexOf("\n\n", start)).replaceAll(/\s+/g, " ");
  const documented: Record<string, number> = {};
  for (const [, names = "", status = ""] of paragraph.matchAll(/((?:`[a-z-]+`(?:, )?)+) \((\d{3})/g)) {
    for (const [, name = ""] of names.matchAll(/`([a-z-]+)`/g)) {
      documented[name] = Number(status);
    }
  }
  return documented;
};

describe("docs/api/hub/http.md", () => {
  it("documents every problem type with the status the hub sends", () => {
    const sent = Object.fromEntries(Object.entries(PROBLEMS).map(([name, { status }]) => [name, status]));

    expect(documentedProblems()).toEqual(sent);
  });
});
