// The event bus and the SSE events stream: docs/architecture/hub/server.md#events
import type { Logger } from "pino";

import { createEventBus } from "./bus.js";
import type { EventBus } from "./bus.js";
import { createStreams } from "./streams.js";
import type { Streams } from "./streams.js";
import type { Timers } from "../observability/index.js";

export { addEventsRoute } from "./events-route.js";
export type { EventBus } from "./bus.js";
export { SYSTEM_ACTOR } from "./event.js";
export type { EventActor, HubEvent } from "./event.js";
export type { Streams } from "./streams.js";

/** The bus and the streams that pass its events on to the web app. */
export interface Events {
  bus: EventBus;
  streams: Streams;
}

export const createEvents = (options: { log: Logger; timers: Timers }): Events => {
  const bus = createEventBus(options.log);
  return { bus, streams: createStreams(bus, options.timers) };
};
