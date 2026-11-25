import pino from "pino";

import { createEvents } from "../../src/server/events/index.js";
import type { Events } from "../../src/server/events/index.js";

/** The bus and streams as the hub makes them, on Node's timers and a log that is thrown away. */
export const createTestEvents = (): Events =>
  createEvents({
    log: pino({ level: "silent" }),
    timers: { setTimeout: (callback, delayMs) => setTimeout(callback, delayMs), clearTimeout },
  });
