// The breakpoints the fake hub sends after welcome: those of HUB_BREAKPOINTS, a JSON array, or none.

/** The breakpoints of `env`: `HUB_BREAKPOINTS`, or none when it is unset or empty. */
export const readBreakpoints = (env: NodeJS.ProcessEnv): unknown[] => {
  const json = env.HUB_BREAKPOINTS ?? "";
  if (json === "") {
    return [];
  }

  const breakpoints: unknown = JSON.parse(json);
  if (!Array.isArray(breakpoints)) {
    throw new TypeError("HUB_BREAKPOINTS must be a JSON array of breakpoints");
  }

  return breakpoints;
};
