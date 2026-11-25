import pino from "pino";
import { describe, expect, it } from "vitest";

import { captureLog } from "../../../../test/server/log-capture.js";
import { createEventBus } from "../bus.js";
import type { HubEvent } from "../event.js";

const event: HubEvent = {
  type: "project.created",
  orgId: "org-a",
  actor: { userId: "user-1" },
  data: { projectId: "project-1" },
};

const createBus = (): { bus: ReturnType<typeof createEventBus>; lines: () => Array<Record<string, unknown>> } => {
  const log = captureLog();
  return { bus: createEventBus(pino({}, log.stream)), lines: () => log.lines() };
};

describe("createEventBus", () => {
  it("hands a published event to every subscriber", () => {
    const { bus } = createBus();
    const first: HubEvent[] = [];
    const second: HubEvent[] = [];
    bus.subscribe((published) => first.push(published));
    bus.subscribe((published) => second.push(published));

    bus.publish(event);

    expect([first, second]).toEqual([[event], [event]]);
  });

  it("stops handing events to a subscriber that unsubscribed", () => {
    const { bus } = createBus();
    const received: HubEvent[] = [];
    const unsubscribe = bus.subscribe((published) => received.push(published));
    unsubscribe();

    bus.publish(event);

    expect(received).toEqual([]);
  });

  it("logs a subscriber that throws and still serves the others without failing the publisher", () => {
    const { bus, lines } = createBus();
    const received: HubEvent[] = [];
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe((published) => received.push(published));

    expect(() => {
      bus.publish(event);
    }).not.toThrow();

    expect(received).toEqual([event]);
    expect(lines()).toMatchObject([{ level: 50, msg: "An event subscriber failed", type: "project.created" }]);
  });
});
