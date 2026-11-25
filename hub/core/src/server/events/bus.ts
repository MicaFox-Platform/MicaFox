import type { Logger } from "pino";

import type { HubEvent } from "./event.js";

/** The in-process bus: parts publish events, and the events streams and the SDK endpoint subscribe. */
export interface EventBus {
  /**
   * Hands `event` to every subscriber at once. A part calls it once its transaction has committed, so a change
   * that rolled back publishes nothing, and a subscriber that reads the database finds the change. A subscriber
   * that throws is logged and never fails the publisher.
   */
  publish: (event: HubEvent) => void;
  /** Adds a subscriber; the function it returns removes it. */
  subscribe: (listener: (event: HubEvent) => void) => () => void;
}

export const createEventBus = (log: Logger): EventBus => {
  const listeners = new Set<(event: HubEvent) => void>();
  return {
    publish: (event) => {
      // A listener may unsubscribe while it runs
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (error) {
          log.error({ err: error, type: event.type, orgId: event.orgId }, "An event subscriber failed");
        }
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
