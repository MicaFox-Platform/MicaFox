import type { FastifyReply, FastifyRequest } from "fastify";

import type { SessionDependencies } from "./dependencies.js";
import { HttpProblem } from "../../app/index.js";
import type { HubApp } from "../../app/index.js";

/** A session lives at most this long, however often it is used. */
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

const CHANGING_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// A token is 43 characters; anything much longer is not ours and is not looked up
const MAX_TOKEN_LENGTH = 128;

/** The cookie's name and whether it is `Secure`: on `http://localhost` it is not, and cannot carry `__Host-`. */
export interface CookieSettings {
  name: string;
  isSecure: boolean;
}

/** The cookie of a hub opened at `publicUrl`: docs/architecture/hub/access.md#logging-in. */
export const cookieSettings = (publicUrl: string): CookieSettings => {
  const isSecure = new URL(publicUrl).protocol === "https:";
  return { name: isSecure ? "__Host-micafox_session" : "micafox_session", isSecure };
};

/** The session token the request's cookie holds, or `undefined` when it has none. */
export const readSessionToken = (request: FastifyRequest, settings: CookieSettings): string | undefined => {
  for (const pair of (request.headers.cookie ?? "").split(";")) {
    const separator = pair.indexOf("=");
    if (separator !== -1 && pair.slice(0, separator).trim() === settings.name) {
      const value = pair.slice(separator + 1).trim();
      return value === "" || value.length > MAX_TOKEN_LENGTH ? undefined : value;
    }
  }
  return undefined;
};

const serialize = (settings: CookieSettings, value: string, maxAgeMs: number): string =>
  [
    `${settings.name}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${String(Math.floor(maxAgeMs / 1000))}`,
    ...(settings.isSecure ? ["Secure"] : []),
  ].join("; ");

/** Sets the session cookie on the response. */
export const setSessionCookie = (reply: FastifyReply, settings: CookieSettings, token: string): void => {
  void reply.header("set-cookie", serialize(settings, token, SESSION_MAX_AGE_MS));
};

/** Tells the browser to drop the session cookie. */
export const clearSessionCookie = (reply: FastifyReply, settings: CookieSettings): void => {
  void reply.header("set-cookie", serialize(settings, "", 0));
};

/**
 * Refuses a changing request that carries the session cookie unless its `Origin` is the hub's: `SameSite=Lax` alone
 * leaves a forged `POST` from a sibling site, and a bearer token carries no cookie, so it needs no origin.
 */
export const addOriginCheck = (app: HubApp, deps: Pick<SessionDependencies, "publicUrl">): void => {
  app.addHook("onRequest", async (request) => {
    const publicUrl = deps.publicUrl();
    if (!CHANGING_METHODS.has(request.method) || readSessionToken(request, cookieSettings(publicUrl)) === undefined) {
      return;
    }
    if (request.headers.origin !== new URL(publicUrl).origin) {
      throw new HttpProblem("origin-mismatch");
    }
    await Promise.resolve();
  });
};
