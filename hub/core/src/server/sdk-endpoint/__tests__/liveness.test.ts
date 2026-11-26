import { PassThrough } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";

import { createManualClock } from "../../../../test/server/manual-clock.js";
import { createLiveness, createRateLimit } from "../liveness.js";
import { SdkSessions } from "../sessions.js";

const KEY = {
  keyId: "key-1",
  prefix: "mfx_pk_abcde",
  orgId: "0b6f3a52-6a3e-4e55-9d0c-6f1c1d2b8a01",
  projectId: "project-1",
  environmentId: "production",
};

const setup = () => {
  const manual = createManualClock();
  const sessions = new SdkSessions({ timers: manual.clock, now: manual.clock.now });
  const liveness = createLiveness({ sessions, timers: manual.clock, now: manual.clock.now });
  const raw = new PassThrough();
  const connection = sessions.reserve(KEY, raw, pino({ enabled: false }));
  liveness.watch();
  return { manual, sessions, liveness, raw, connection };
};

describe("createLiveness", () => {
  it("cuts off a connection that received nothing for 45 s", () => {
    const { manual, raw } = setup();
    manual.advance(44_999);
    const cutEarly = raw.destroyed;

    manual.advance(5000);

    expect([cutEarly, raw.destroyed]).toEqual([false, true]);
  });

  it("keeps a connection that received something, such as a ping, in the last 45 s", () => {
    const { manual, sessions, raw, connection } = setup();
    manual.advance(40_000);
    sessions.touch(connection);

    manual.advance(40_000);

    expect(raw.destroyed).toBe(false);
  });

  it("runs no sweep once there are no connections", async () => {
    const { manual, raw, connection } = setup();
    raw.destroy();
    await connection.closed;

    manual.advance(5000);

    expect(manual.pendingOf(5000)).toBe(0);
  });

  it("stops the sweep on stop", () => {
    const { manual, liveness } = setup();

    liveness.stop();

    expect(manual.pendingOf(5000)).toBe(0);
  });
});

describe("createRateLimit", () => {
  // `count` messages taken at once, as a batch takes them
  const takeMany = (limit: ReturnType<typeof createRateLimit>, count: number): boolean[] =>
    Array.from({ length: count }, () => limit.take());

  it("lets through 10 seconds' worth at once and drops the rest", () => {
    const manual = createManualClock();
    const limit = createRateLimit({ perSecond: 5, now: manual.clock.now });

    const answers = takeMany(limit, 52);

    expect(answers.filter(Boolean)).toHaveLength(50);
    expect(answers.slice(50)).toEqual([false, false]);
  });

  it("refills the rate a second", () => {
    const manual = createManualClock();
    const limit = createRateLimit({ perSecond: 5, now: manual.clock.now });
    takeMany(limit, 50);

    manual.advance(1000);

    expect(takeMany(limit, 6).filter(Boolean)).toHaveLength(5);
  });

  it("never holds more than 10 seconds' worth, however long the session was quiet", () => {
    const manual = createManualClock();
    const limit = createRateLimit({ perSecond: 5, now: manual.clock.now });

    manual.advance(3_600_000);

    expect(takeMany(limit, 51).filter(Boolean)).toHaveLength(50);
  });
});
