const REDACTED = "[redacted]";
const CIRCULAR = "[circular]";
const TOO_DEEP = "[too deep]";
// Log objects are shallow; the bound keeps a hostile or cyclic payload from costing more than this per line
const MAX_DEPTH = 16;
// Matched anywhere in a key, so `Proxy-Authorization`, `Set-Cookie` and `setupToken` are caught; this over-redacts
// on purpose, since a hidden count costs less than a leaked secret
const SECRET_WORDS = ["authorization", "cookie", "password", "token", "secret"];

const isSecretKey = (key: string): boolean => {
  const name = key.toLowerCase();
  return SECRET_WORDS.some((word) => name.includes(word));
};

// Class instances such as a request, a socket or an Error are left to pino's serializers: walking them
// would visit servers and sockets, and could run getters
const isPlainObject = (value: object): boolean => {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const redactValue = (value: unknown, depth: number, ancestors: WeakSet<object>): unknown => {
  if (typeof value !== "object" || value === null || !(Array.isArray(value) || isPlainObject(value))) {
    return value;
  }
  if (ancestors.has(value)) {
    return CIRCULAR;
  }
  if (depth >= MAX_DEPTH) {
    return TOO_DEEP;
  }
  ancestors.add(value);
  const copy = Array.isArray(value)
    ? value.map((item: unknown) => redactValue(item, depth + 1, ancestors))
    : Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          isSecretKey(key) ? REDACTED : redactValue(item, depth + 1, ancestors),
        ]),
      );
  ancestors.delete(value);
  return copy;
};

/** Copies a log object with every authorization, cookie, password, token and secret value replaced, at any depth. */
export const redactSecrets = (value: Record<string, unknown>): Record<string, unknown> => {
  const redacted = redactValue(value, 0, new WeakSet());
  return redacted as Record<string, unknown>; // a plain object in gives a plain object out
};
