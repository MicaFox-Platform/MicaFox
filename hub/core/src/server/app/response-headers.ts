import type { FastifyReply, FastifyRequest } from "fastify";

// `base-uri` and `form-action` do not fall back to `default-src`, so injected markup could otherwise redirect them
const CONTENT_SECURITY_POLICY = "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const ONE_YEAR_SECONDS = 31_536_000;

/** Sets the request id and the security headers on a reply. */
export type SetResponseHeaders = (request: FastifyRequest, reply: FastifyReply) => void;

/**
 * Creates the setter of the headers every response carries; HSTS only when users reach the hub over HTTPS. The app
 * calls it from a root `onSend` hook rather than using `@fastify/helmet`: a plugin's hooks are added when it loads,
 * after the readiness gate's, and would miss its replies. A hijacked reply, such as an events stream, skips `onSend`
 * and sets its own headers.
 */
export const createResponseHeaders = (publicUrl: string | undefined): SetResponseHeaders => {
  const headers: Record<string, string> = {
    "content-security-policy": CONTENT_SECURITY_POLICY,
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    ...(publicUrl?.startsWith("https:") === true
      ? { "strict-transport-security": `max-age=${String(ONE_YEAR_SECONDS)}` }
      : {}),
  };
  return (request, reply) => {
    void reply.headers({ ...headers, "x-request-id": request.id });
  };
};
