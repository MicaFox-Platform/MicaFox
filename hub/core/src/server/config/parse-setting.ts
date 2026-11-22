import { isIP } from "node:net";

/** The outcome of reading one setting; a problem names the rule, never the value, since values can be secrets. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const PROJECT_KEY = /^mfx_pk_[A-Za-z0-9_-]{43}$/;
const MAX_IPV4_PREFIX = 32;
const MAX_IPV6_PREFIX = 128;
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 256;

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = (problem: string): Parsed<never> => ({ ok: false, problem });

const parseUrl = (raw: string): URL | undefined => {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
};

/** An integer in `min..max`. */
export const parseInteger = (raw: string, min: number, max: number): Parsed<number> => {
  const value = /^\d{1,15}$/.test(raw) ? Number(raw) : Number.NaN;
  if (value >= min && value <= max) {
    return ok(value);
  }
  return fail(`must be an integer from ${String(min)} to ${String(max)}`);
};

/** `true` or `false`. */
export const parseBoolean = (raw: string): Parsed<boolean> => {
  if (raw === "true" || raw === "false") {
    return ok(raw === "true");
  }
  return fail("must be true or false");
};

/** One of the listed words. */
export const parseChoice = <T extends string>(raw: string, choices: readonly T[]): Parsed<T> => {
  const choice = choices.find((candidate) => candidate === raw);
  return choice === undefined ? fail(`must be one of ${choices.join(", ")}`) : ok(choice);
};

/** A host name or address to listen on: not empty, no spaces or slashes. */
export const parseHost = (raw: string): Parsed<string> =>
  /^[^\s/]+$/.test(raw) ? ok(raw) : fail("must be a host name or an IP address");

const hasMoreThanOrigin = (url: URL): boolean =>
  url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "";

/** The URL users open: HTTPS, or HTTP only on this machine, with no path; returns its origin. */
export const parsePublicUrl = (raw: string): Parsed<string> => {
  const url = parseUrl(raw);
  if (url === undefined || (url.protocol !== "https:" && url.protocol !== "http:")) {
    return fail("must be an https:// URL, or http:// on localhost, 127.0.0.1 or [::1]");
  }
  if (url.protocol === "http:" && !LOCAL_HOSTS.has(url.hostname)) {
    return fail("must be https://, since http:// is allowed only on localhost, 127.0.0.1 or [::1]");
  }
  if (hasMoreThanOrigin(url)) {
    return fail("must have no credentials, path, query or fragment");
  }
  return ok(url.origin);
};

/** Where the UI's Source link points: an http(s) URL without credentials, since it is shown and logged. */
export const parseSourceUrl = (raw: string): Parsed<string> => {
  const url = parseUrl(raw);
  if (url === undefined || (url.protocol !== "https:" && url.protocol !== "http:")) {
    return fail("must be an http:// or https:// URL");
  }
  if (url.username !== "" || url.password !== "") {
    return fail("must have no credentials");
  }
  return ok(raw);
};

/** A Postgres URL, or `pglite:memory` or `pglite:<folder>`. */
export const parseDatabaseUrl = (raw: string): Parsed<string> => {
  if (raw.startsWith("pglite:")) {
    return raw.length > "pglite:".length ? ok(raw) : fail("must name memory or a folder after pglite:");
  }
  const url = parseUrl(raw);
  if (url !== undefined && (url.protocol === "postgres:" || url.protocol === "postgresql:") && url.hostname !== "") {
    return ok(raw);
  }
  return fail("must be a postgres:// URL, or pglite:memory or pglite:<folder>");
};

const isCidr = (raw: string): boolean => {
  const [address = "", prefix, ...rest] = raw.split("/");
  const family = isIP(address);
  if (family === 0) {
    return false;
  }
  if (prefix === undefined) {
    return rest.length === 0;
  }
  const maxPrefix = family === 4 ? MAX_IPV4_PREFIX : MAX_IPV6_PREFIX;
  return rest.length === 0 && parseInteger(prefix, 0, maxPrefix).ok;
};

/** Which proxies to believe: `true`, `false`, a hop count, or IP addresses and CIDRs. */
export const parseTrustProxy = (raw: string): Parsed<boolean | number | string[]> => {
  const flag = parseBoolean(raw);
  if (flag.ok) {
    return flag;
  }
  if (/^\d+$/.test(raw)) {
    return parseInteger(raw, 0, 255);
  }
  const entries = raw.split(",").map((entry) => entry.trim());
  if (entries.every(isCidr)) {
    return ok(entries);
  }
  return fail("must be true, false, a hop count, or a comma-separated list of IP addresses and CIDRs");
};

/** A project key: `mfx_pk_` and 43 characters. */
export const parseProjectKey = (raw: string): Parsed<string> =>
  PROJECT_KEY.test(raw) ? ok(raw) : fail("must be mfx_pk_ followed by 43 characters");

/** The seeded owner's password: 12 to 256 characters. */
export const parsePassword = (raw: string): Parsed<string> =>
  raw.length >= MIN_PASSWORD_LENGTH && raw.length <= MAX_PASSWORD_LENGTH
    ? ok(raw)
    : fail(`must be ${String(MIN_PASSWORD_LENGTH)} to ${String(MAX_PASSWORD_LENGTH)} characters`);

/** A secret with no format of its own: not empty. */
export const parseSecret = (raw: string): Parsed<string> => (raw === "" ? fail("must not be empty") : ok(raw));
