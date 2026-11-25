import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEventBus } from "../bus.js";
import type { HubEvent } from "../event.js";
import { createStreams, MAX_STREAMS_PER_USER } from "../streams.js";

const KEEPALIVE_MS = 25_000;

const eventOf = (orgId: string): HubEvent => ({
  type: "key.created",
  orgId,
  actor: { userId: "user-1" },
  data: {},
});

const timers = {
  setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  clearTimeout: (handle: NodeJS.Timeout) => {
    clearTimeout(handle);
  },
};

const setup = (): {
  bus: ReturnType<typeof createEventBus>;
  streams: ReturnType<typeof createStreams>;
  open: (userId: string, orgIds: string[]) => { written: string[]; isEnded: () => boolean };
} => {
  const bus = createEventBus(pino({ level: "silent" }));
  const streams = createStreams(bus, timers);
  return {
    bus,
    streams,
    open: (userId, orgIds) => {
      const written: string[] = [];
      let isEnded = false;
      streams.open({
        userId,
        orgIds: new Set(orgIds),
        sink: {
          write: (chunk) => {
            written.push(chunk);
            return true;
          },
          end: () => {
            isEnded = true;
          },
        },
      });
      return { written, isEnded: () => isEnded };
    },
  };
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const eventsOf = (written: string[]): string[] => written.filter((frame) => frame.startsWith("event: key."));

describe("createStreams", () => {
  it("passes an event on only to the streams of its organization", () => {
    const { bus, open } = setup();
    const memberOfA = open("user-a", ["org-a"]);
    const memberOfB = open("user-b", ["org-b"]);

    bus.publish(eventOf("org-a"));

    expect([eventsOf(memberOfA.written).length, eventsOf(memberOfB.written).length]).toEqual([1, 0]);
  });

  it("sends a keepalive comment every 25 seconds", () => {
    const { open } = setup();
    const { written } = open("user-a", ["org-a"]);

    vi.advanceTimersByTime(KEEPALIVE_MS * 2);

    expect(written.filter((frame) => frame === ": keepalive\n\n")).toHaveLength(2);
  });

  it("ends every stream of one user and no other", () => {
    const { streams, open } = setup();
    const first = open("user-a", ["org-a"]);
    const second = open("user-a", ["org-a"]);
    const other = open("user-b", ["org-a"]);

    streams.endUser("user-a");

    expect([first.isEnded(), second.isEnded(), other.isEnded()]).toEqual([true, true, false]);
  });

  it("ends a user's oldest stream when they open one more than 10, and no other", () => {
    const { open } = setup();
    const oldest = open("user-a", ["org-a"]);
    const others = Array.from({ length: MAX_STREAMS_PER_USER - 1 }, () => open("user-a", ["org-a"]));
    const otherUser = open("user-b", ["org-a"]);

    const newest = open("user-a", ["org-a"]);

    expect([oldest, ...others, newest, otherUser].map((stream) => stream.isEnded())).toEqual([
      true,
      ...others.map(() => false),
      false,
      false,
    ]);
  });

  it("ends every stream", () => {
    const { streams, open } = setup();
    const first = open("user-a", ["org-a"]);
    const other = open("user-b", ["org-b"]);

    streams.endAll();

    expect([first.isEnded(), other.isEnded()]).toEqual([true, true]);
  });

  it("forgets an ended stream: no more events and no more keepalives", () => {
    const { bus, streams, open } = setup();
    const { written } = open("user-a", ["org-a"]);
    streams.endUser("user-a");
    const before = written.length;

    bus.publish(eventOf("org-a"));
    vi.advanceTimersByTime(KEEPALIVE_MS);

    expect(written).toHaveLength(before);
  });
});
