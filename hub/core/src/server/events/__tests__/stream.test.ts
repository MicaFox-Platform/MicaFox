import { describe, expect, it } from "vitest";

import type { HubEvent } from "../event.js";
import { EventStream, MAX_UNDELIVERED } from "../stream.js";

// A sink whose client takes what it is given until `isSlow` is set
const createSink = (): {
  written: string[];
  isEnded: () => boolean;
  slowDown: () => void;
  catchUp: () => void;
  sink: ConstructorParameters<typeof EventStream>[0]["sink"];
} => {
  const written: string[] = [];
  let isSlow = false;
  let isEnded = false;
  return {
    written,
    isEnded: () => isEnded,
    slowDown: () => {
      isSlow = true;
    },
    catchUp: () => {
      isSlow = false;
    },
    sink: {
      write: (chunk) => {
        written.push(chunk);
        return !isSlow;
      },
      end: () => {
        isEnded = true;
      },
    },
  };
};

const eventOf = (orgId: string, projectId = "project-1"): HubEvent => ({
  type: "project.created",
  orgId,
  actor: { userId: "user-1" },
  data: { projectId },
});

const open = (orgIds: string[] = ["org-a"]): ReturnType<typeof createSink> & { stream: EventStream } => {
  const sink = createSink();
  return { ...sink, stream: new EventStream({ userId: "user-1", orgIds: new Set(orgIds), sink: sink.sink }) };
};

describe("EventStream", () => {
  it("starts with reset", () => {
    const { written } = open();

    expect(written).toEqual(["event: reset\ndata: {}\n\n"]);
  });

  it("sends an event of the user's organization as a named frame holding the event", () => {
    const { written, stream } = open();
    const event = eventOf("org-a");

    stream.offer(event);

    expect(written.at(-1)).toBe(`event: project.created\ndata: ${JSON.stringify(event)}\n\n`);
  });

  it("sends nothing of an organization the user is not in", () => {
    const { written, stream } = open(["org-a"]);

    stream.offer(eventOf("org-b"));

    expect(written).toEqual(["event: reset\ndata: {}\n\n"]);
  });

  it("keeps what a slow client could not take and sends it in order once it caught up", () => {
    const { written, stream, slowDown, catchUp } = open();
    slowDown();
    stream.offer(eventOf("org-a", "project-1"));
    stream.offer(eventOf("org-a", "project-2"));
    catchUp();

    stream.onDrain();

    expect(written.slice(1).map((frame) => /project-\d/.exec(frame)?.[0])).toEqual(["project-1", "project-2"]);
  });

  it("keeps what is left of the queue when the client is slow again while it is sent", () => {
    const { written, stream, slowDown, catchUp } = open();
    slowDown();
    // The first goes out and makes the client slow; the second goes out at the slow drain, the third stays
    stream.offer(eventOf("org-a", "project-1"));
    stream.offer(eventOf("org-a", "project-2"));
    stream.offer(eventOf("org-a", "project-3"));
    stream.onDrain();
    catchUp();

    stream.onDrain();

    expect(written.slice(1).map((frame) => /project-\d/.exec(frame)?.[0])).toEqual([
      "project-1",
      "project-2",
      "project-3",
    ]);
  });

  it("keeps up to 100 undelivered events behind the one that made the client slow", () => {
    const { written, stream, slowDown, catchUp } = open();
    slowDown();
    for (let index = 0; index < MAX_UNDELIVERED + 1; index += 1) {
      stream.offer(eventOf("org-a"));
    }
    catchUp();

    stream.onDrain();

    expect(written.filter((frame) => frame.startsWith("event: project.created"))).toHaveLength(MAX_UNDELIVERED + 1);
  });

  it("drops the queue at the 101st undelivered event and sends reset once the client caught up", () => {
    const { written, stream, slowDown, catchUp } = open();
    slowDown();
    // The first one is written, and makes the client slow; the next 100 wait, and one more is one too many
    for (let index = 0; index < MAX_UNDELIVERED + 2; index += 1) {
      stream.offer(eventOf("org-a"));
    }
    catchUp();

    stream.onDrain();

    expect(written.map((frame) => frame.slice(0, 12))).toEqual(["event: reset", "event: proje", "event: reset"]);
  });

  it("sends nothing between the drop and the reset, then goes on with new events", () => {
    const { written, stream, slowDown, catchUp } = open();
    slowDown();
    for (let index = 0; index < MAX_UNDELIVERED + 2; index += 1) {
      stream.offer(eventOf("org-a", "project-1"));
    }
    stream.offer(eventOf("org-a", "project-late"));
    catchUp();
    stream.onDrain();

    stream.offer(eventOf("org-a", "project-next"));

    expect(written.map((frame) => /reset|project-\w+/.exec(frame)?.[0])).toEqual([
      "reset",
      "project-1",
      "reset",
      "project-next",
    ]);
  });

  it("sends a keepalive comment, but not to a client that is behind", () => {
    const { written, stream, slowDown } = open();
    stream.keepAlive();
    slowDown();
    stream.offer(eventOf("org-a"));
    stream.keepAlive();

    expect(written).toEqual([
      "event: reset\ndata: {}\n\n",
      ": keepalive\n\n",
      expect.stringContaining("project.created"),
    ]);
  });

  it("ends its sink once and sends nothing afterwards", () => {
    const { written, stream, isEnded } = open();
    stream.end();

    stream.offer(eventOf("org-a"));
    stream.keepAlive();
    stream.onDrain();
    stream.end();

    expect([isEnded(), written]).toEqual([true, ["event: reset\ndata: {}\n\n"]]);
  });
});
