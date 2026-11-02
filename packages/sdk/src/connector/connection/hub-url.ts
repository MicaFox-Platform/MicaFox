/** Where the connector connects; `href` has no userinfo or fragment. */
export interface HubTarget {
  href: string;
  isSecure: boolean;
  /** Origin and path only, the one form of the URL that is ever logged: userinfo and query may hold secrets. */
  description: string;
}

/** The result of `checkHubTarget()`: a target, or the reason, which never contains the URL or the token. */
export type HubTargetCheck = { ok: true; target: HubTarget } | { ok: false; reason: string };

// Node's own test for a header value; `http.request` throws on anything else, on every attempt
const INVALID_HEADER_CHAR = /[^\t\x20-\x7e\x80-\xff]/;

// Matched on the WHATWG-normalized hostname, by name only: a DNS answer could point anywhere (ADR 0006)
const isLoopback = (hostname: string): boolean => {
  if (hostname === "localhost" || hostname === "[::1]") {
    return true;
  }

  // The URL parser turns every IPv4 form (`127.1`, `0x7f.1`) into four decimal parts, so this sees only those
  return /^127(?:\.\d{1,3}){3}$/.test(hostname);
};

const parse = (url: string): URL | undefined => {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
};

/**
 * Checks the hub URL and the token before any network attempt: a URL that is missing, not `ws://` or `wss://`, or
 * a token that would go over `ws://` to a non-loopback host or cannot be a header value.
 */
export const checkHubTarget = (url: string | undefined, token: string | undefined): HubTargetCheck => {
  if (url === undefined) {
    return { ok: false, reason: "no hub URL is set; pass url or set PROBEX_HUB_URL" };
  }

  const parsed = parse(url);
  if (parsed === undefined || (parsed.protocol !== "ws:" && parsed.protocol !== "wss:")) {
    return { ok: false, reason: "the hub URL must be a ws:// or wss:// URL" };
  }

  const isSecure = parsed.protocol === "wss:";
  if (token !== undefined && !isSecure && !isLoopback(parsed.hostname)) {
    return { ok: false, reason: "a token is sent over ws:// only to localhost, 127.0.0.0/8 or [::1]; use wss://" };
  }

  if (token !== undefined && INVALID_HEADER_CHAR.test(token)) {
    return { ok: false, reason: "the token contains characters an HTTP header cannot carry" };
  }

  const description = `${parsed.origin}${parsed.pathname}`;
  // Userinfo would go out as `Authorization: Basic`, in clear over ws://; a fragment is never sent and ws rejects it
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  return { ok: true, target: { href: parsed.href, isSecure, description } };
};
