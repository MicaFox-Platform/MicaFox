// The default import: code scanning recognises the limiter by its module, not by a named member
import fastifyRateLimit from "@fastify/rate-limit";
import type { RateLimitOptions, RateLimitPluginOptions } from "@fastify/rate-limit";

import { HttpProblem } from "../../app/index.js";
import type { HubApp } from "../../app/index.js";

/**
 * The limit of each route that checks a secret: 100 attempts per IP in 10 minutes, at most 10,000 IPs remembered,
 * the least recently used dropped first. Each route has its own counter: @fastify/rate-limit gives each route
 * configuration a store of its own (ADR 0040).
 */
export const PER_IP_LIMIT: RateLimitOptions = { max: 100, timeWindow: 10 * 60_000, cache: 10_000 };

const NO_HEADERS = {
  "x-ratelimit-limit": false,
  "x-ratelimit-remaining": false,
  "x-ratelimit-reset": false,
  "retry-after": false,
} as const;

// Only routes with `config.rateLimit` are limited. The plugin's headers are off, so `Retry-After` comes from the
// problem alone, like every other 429 of the hub
const PLUGIN_OPTIONS: RateLimitPluginOptions = {
  global: false,
  addHeaders: NO_HEADERS,
  addHeadersOnExceeding: NO_HEADERS,
  // The plugin throws what this returns, and the hub's error handler answers it as a problem
  errorResponseBuilder: (_request, context) =>
    new HttpProblem("rate-limited", {}, Math.max(1, Math.ceil(context.ttl / 1000))),
};

/**
 * Adds the per-IP limit to `app`. It sees only the routes added after it, so it comes first in the access plugin;
 * a route added before it would go unlimited without an error.
 */
export const addPerIpLimit = (app: HubApp): void => {
  void app.register(fastifyRateLimit, PLUGIN_OPTIONS);
};
