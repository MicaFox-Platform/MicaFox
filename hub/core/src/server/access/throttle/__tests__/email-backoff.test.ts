import { describe, expect, it } from "vitest";

import { createEmailBackoff } from "../email-backoff.js";

const MINUTE = 60_000;

const create = (): { throttle: ReturnType<typeof createEmailBackoff>; advance: (ms: number) => void } => {
  let time = 1_000_000;
  return {
    throttle: createEmailBackoff(() => time),
    advance: (ms) => {
      time += ms;
    },
  };
};

const failTimes = (throttle: ReturnType<typeof createEmailBackoff>, email: string, times: number): void => {
  for (let count = 0; count < times; count += 1) {
    throttle.recordFailure(email);
  }
};

const failOnceEach = (throttle: ReturnType<typeof createEmailBackoff>, emails: number): void => {
  for (let index = 0; index < emails; index += 1) {
    throttle.recordFailure(`user${String(index)}@acme.dev`);
  }
};

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

  it("forgets the least recently failed email when it holds 10000", () => {
    const { throttle } = create();
    failTimes(throttle, "first@acme.dev", 5);
    failOnceEach(throttle, 10_000);

    expect(throttle.waitFor("first@acme.dev")).toBeUndefined();
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
