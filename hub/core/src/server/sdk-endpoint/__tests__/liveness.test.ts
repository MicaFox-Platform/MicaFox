import { PassThrough } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";

import { createManualClock } from "../../../../test/server/manual-clock.js";
import { createLiveness } from "../liveness.js";
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
