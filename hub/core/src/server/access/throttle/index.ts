import { normalizeEmail } from "../global-tables/index.js";

const IP_WINDOW_MS = 10 * 60_000;
const IP_ATTEMPTS_PER_WINDOW = 100;
const FREE_FAILURES = 5;
const MAX_WAIT_SECONDS = 60;
// A failure is forgotten after this long without another, so one typo a month ago never slows a login
const FAILURE_MEMORY_MS = 60 * 60_000;
// Each map keeps at most this many keys: a flood of fresh IPs or emails drops the oldest, never grows the memory
const MAX_KEYS = 10_000;

interface IpWindow {
  endsAt: number;
  attempts: number;
}

interface EmailFailures {
  count: number;
  /** No attempt for this email is checked before this time. */
  blockedUntil: number;
  forgottenAt: number;
}

/**
 * What limits password guessing: attempts per IP and failures per email. The counters live in this replica's
 * memory (docs/architecture/hub/access.md#logging-in). Each answer is the seconds to wait, or `undefined` to go on.
 */
export interface LoginThrottle {
  /** Counts an attempt from `ip`; the wait is set when it is over 100 in 10 minutes. */
  countAttempt: (ip: string) => number | undefined;
  /** The wait before `email` may be tried again, after 5 failures; an unknown email counts like a known one. */
  waitFor: (email: string) => number | undefined;
  recordFailure: (email: string) => void;
  recordSuccess: (email: string) => void;
}

const secondsUntil = (time: number, now: number): number => Math.max(1, Math.ceil((time - now) / 1000));

// Re-inserting moves a key to the end, so the first key is the one used least recently
const remember = <Value>(map: Map<string, Value>, key: string, value: Value): void => {
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
export const createLoginThrottle = (now: () => number): LoginThrottle => {
  const windows = new Map<string, IpWindow>();
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
    countAttempt: (ip) => {
      const time = now();
      const current = windows.get(ip);
      const window =
        current !== undefined && time < current.endsAt ? current : { endsAt: time + IP_WINDOW_MS, attempts: 0 };
      const next: IpWindow = { endsAt: window.endsAt, attempts: window.attempts + 1 };
      remember(windows, ip, next);
      return next.attempts > IP_ATTEMPTS_PER_WINDOW ? secondsUntil(next.endsAt, time) : undefined;
    },
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
