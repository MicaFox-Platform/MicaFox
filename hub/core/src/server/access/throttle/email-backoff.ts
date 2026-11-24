import { normalizeEmail } from "../global-tables/index.js";

const FREE_FAILURES = 5;
const MAX_WAIT_SECONDS = 60;
// A failure is forgotten after this long without another, so one typo a month ago never slows a login
const FAILURE_MEMORY_MS = 60 * 60_000;
// The map keeps at most this many emails: a flood of fresh ones drops the oldest, never grows the memory
const MAX_KEYS = 10_000;

interface EmailFailures {
  count: number;
  /** No attempt for this email is checked before this time. */
  blockedUntil: number;
  forgottenAt: number;
}

/**
 * What slows guessing one account's password: failures per email, in this replica's memory
 * (docs/architecture/hub/access.md#logging-in). The limit per IP is `addPerIpLimit`'s.
 */
export interface EmailBackoff {
  /** The wait before `email` may be tried again, after 5 failures; an unknown email counts like a known one. */
  waitFor: (email: string) => number | undefined;
  recordFailure: (email: string) => void;
  recordSuccess: (email: string) => void;
}

const secondsUntil = (time: number, now: number): number => Math.max(1, Math.ceil((time - now) / 1000));

// Re-inserting moves a key to the end, so the first key is the one used least recently
const remember = (map: Map<string, EmailFailures>, key: string, value: EmailFailures): void => {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_KEYS) {
    const oldest = map.keys().next();
    if (oldest.done !== true) {
      map.delete(oldest.value);
    }
  }
};

/** Builds the counters; `now` is the clock in milliseconds. */
export const createEmailBackoff = (now: () => number): EmailBackoff => {
  const failures = new Map<string, EmailFailures>();

  const liveFailures = (key: string): EmailFailures | undefined => {
    const entry = failures.get(key);
    if (entry !== undefined && now() >= entry.forgottenAt) {
      failures.delete(key);
      return undefined;
    }
    return entry;
  };

  return {
    waitFor: (email) => {
      const entry = liveFailures(normalizeEmail(email));
      const time = now();
      return entry !== undefined && time < entry.blockedUntil ? secondsUntil(entry.blockedUntil, time) : undefined;
    },
    recordFailure: (email) => {
      const key = normalizeEmail(email);
      const time = now();
      const count = (liveFailures(key)?.count ?? 0) + 1;
      // 1 s after the 5th failure, doubling with each one, up to a minute
      const waitSeconds = count < FREE_FAILURES ? 0 : Math.min(2 ** (count - FREE_FAILURES), MAX_WAIT_SECONDS);
      remember(failures, key, {
        count,
        blockedUntil: time + waitSeconds * 1000,
        forgottenAt: time + FAILURE_MEMORY_MS,
      });
    },
    recordSuccess: (email) => {
      failures.delete(normalizeEmail(email));
    },
  };
};
