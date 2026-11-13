// The breakpoints the fake hub sends after welcome: those of HUB_BREAKPOINTS, a JSON array, or none. Each entry's
// `expiresInMs` is the time it has left, counted down from when the hub started.

/** What an entry of HUB_BREAKPOINTS gets when its `expiresInMs` is not an integer of at least 0: 1 h. */
export const DEFAULT_EXPIRES_IN_MS = 3_600_000;

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

const isObject = (entry: unknown): entry is Record<string, unknown> => typeof entry === "object" && entry !== null;

const readExpiresInMs = (entry: Record<string, unknown>): number => {
  const { expiresInMs } = entry;
  return typeof expiresInMs === "number" && Number.isInteger(expiresInMs) && expiresInMs >= 0
    ? expiresInMs
    : DEFAULT_EXPIRES_IN_MS;
};

/**
 * Fixes each entry's deadline at the time of this call (`now()` plus its `expiresInMs`) and returns a function that
 * builds the list to send: the entries, each with the time left at that moment, never less than 0. An entry that is not
 * an object is passed on as it is, so the SDK's checks of a bad entry can be tried.
 */
export const startCountdown = (breakpoints: readonly unknown[], now: () => number = Date.now): (() => unknown[]) => {
  const started = now();
  const deadlines = breakpoints.map((entry) => ({
    entry,
    deadline: isObject(entry) ? started + readExpiresInMs(entry) : 0,
  }));

  return () => {
    const current = now();
    return deadlines.map(({ entry, deadline }) =>
      isObject(entry) ? { ...entry, expiresInMs: Math.max(0, deadline - current) } : entry,
    );
  };
};
