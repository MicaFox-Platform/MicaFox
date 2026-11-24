import { describe, expect, it } from "vitest";

import { createLoginThrottle } from "../index.js";

const MINUTE = 60_000;

const create = (): { throttle: ReturnType<typeof createLoginThrottle>; advance: (ms: number) => void } => {
  let time = 1_000_000;
  return {
    throttle: createLoginThrottle(() => time),
    advance: (ms) => {
      time += ms;
    },
  };
};

const failTimes = (throttle: ReturnType<typeof createLoginThrottle>, email: string, times: number): void => {
  for (let count = 0; count < times; count += 1) {
    throttle.recordFailure(email);
  }
};

describe("countAttempt", () => {
  it("lets 100 attempts of an IP through in 10 minutes and refuses the 101st with the time left", () => {
    const { throttle, advance } = create();
    for (let count = 0; count < 100; count += 1) {
      throttle.countAttempt("203.0.113.5");
    }
    advance(4 * MINUTE);

    expect(throttle.countAttempt("203.0.113.5")).toBe(6 * 60);
  });

  it("counts each IP on its own", () => {
    const { throttle } = create();
    for (let count = 0; count < 101; count += 1) {
      throttle.countAttempt("203.0.113.5");
    }

    expect(throttle.countAttempt("203.0.113.6")).toBeUndefined();
  });

  it("starts a new window once the 10 minutes are over", () => {
    const { throttle, advance } = create();
    for (let count = 0; count < 101; count += 1) {
      throttle.countAttempt("203.0.113.5");
    }
    advance(10 * MINUTE);

    expect(throttle.countAttempt("203.0.113.5")).toBeUndefined();
  });

  it("forgets the least recently used IP when it holds 10000", () => {
    const { throttle } = create();
    for (let count = 0; count < 101; count += 1) {
      throttle.countAttempt("first");
    }
    for (let ip = 0; ip < 10_000; ip += 1) {
      throttle.countAttempt(`ip-${String(ip)}`);
    }

    expect(throttle.countAttempt("first")).toBeUndefined();
  });
});

describe("waitFor", () => {
  it("does not wait for an email with fewer than 5 failures", () => {
    const { throttle } = create();
    failTimes(throttle, "ann@acme.dev", 4);

    expect(throttle.waitFor("ann@acme.dev")).toBeUndefined();
  });

  it("waits 1 s after the 5th failure and doubles the wait with each one", () => {
    const { throttle } = create();
    failTimes(throttle, "ann@acme.dev", 5);
    const afterFifth = throttle.waitFor("ann@acme.dev");
    failTimes(throttle, "ann@acme.dev", 1);
    const afterSixth = throttle.waitFor("ann@acme.dev");

    expect([afterFifth, afterSixth]).toEqual([1, 2]);
  });

  it("waits at most 60 s", () => {
    const { throttle } = create();
    failTimes(throttle, "ann@acme.dev", 30);

    expect(throttle.waitFor("ann@acme.dev")).toBe(60);
  });

  it("stops waiting once the time has passed", () => {
    const { throttle, advance } = create();
    failTimes(throttle, "ann@acme.dev", 6);
    advance(2000);

    expect(throttle.waitFor("ann@acme.dev")).toBeUndefined();
  });

  it("counts an email whatever its case and spaces, known or not", () => {
    const { throttle } = create();
    failTimes(throttle, "Ann@Acme.dev ", 5);

    expect(throttle.waitFor("ann@acme.dev")).toBe(1);
  });

  it("clears the failures of an email after a success", () => {
    const { throttle } = create();
    failTimes(throttle, "ann@acme.dev", 5);
    throttle.recordSuccess("ann@acme.dev");

    expect(throttle.waitFor("ann@acme.dev")).toBeUndefined();
  });

  it("forgets failures after an hour without another", () => {
    const { throttle, advance } = create();
    failTimes(throttle, "ann@acme.dev", 4);
    advance(61 * MINUTE);
    failTimes(throttle, "ann@acme.dev", 1);

    expect(throttle.waitFor("ann@acme.dev")).toBeUndefined();
  });
});
