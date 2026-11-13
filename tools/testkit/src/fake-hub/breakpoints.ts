// The breakpoints the fake hub sends after welcome: HUB_BREAKPOINTS wins over HUB_BREAKPOINTS_FILE, which wins over
// none. A file lets a script such as `dev:hub` ship its sample as data.

import { readFileSync } from "node:fs";

const parseBreakpoints = (json: string, source: string): unknown[] => {
  const breakpoints: unknown = JSON.parse(json);
  if (!Array.isArray(breakpoints)) {
    throw new TypeError(`${source} must be a JSON array of breakpoints`);
  }

  return breakpoints;
};

/** The breakpoints of `env`: `HUB_BREAKPOINTS`, else the file `HUB_BREAKPOINTS_FILE` names, else none. */
export const readBreakpoints = (env: NodeJS.ProcessEnv): unknown[] => {
  const json = env.HUB_BREAKPOINTS ?? "";
  if (json !== "") {
    return parseBreakpoints(json, "HUB_BREAKPOINTS");
  }

  const file = env.HUB_BREAKPOINTS_FILE ?? "";
  return file === "" ? [] : parseBreakpoints(readFileSync(file, "utf8"), "HUB_BREAKPOINTS_FILE");
};
