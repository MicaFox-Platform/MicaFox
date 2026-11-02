import { describe, expect, it } from "vitest";

import { TokenBucket } from "./token-bucket.js";

// 1000 bytes per second is one byte per millisecond, so waits read as byte counts
const BYTES_PER_SECOND = 1000;

const createClock = (): { now: () => number; advance: (ms: number) => void } => {
  let nowMs = 0;
  return {
    now: () => nowMs,
    advance: (ms) => {
      nowMs += ms;
    },
  };
};

// Sends `frameBytes` frames as fast as the bucket allows for `durationMs`, starting with a full bucket, and returns
// how many bytes went out
const sendAsFastAsAllowed = (frameBytes: number, durationMs: number): number => {
  const clock = createClock();
  const bucket = new TokenBucket(BYTES_PER_SECOND, clock.now);
  let sentBytes = 0;
  for (let waitMs = bucket.waitMs(frameBytes); clock.now() + waitMs <= durationMs; waitMs = bucket.waitMs(frameBytes)) {
    clock.advance(waitMs);
    bucket.take(frameBytes);
    sentBytes += frameBytes;
  }

  return sentBytes;
};

describe("TokenBucket", () => {
  it("lets a burst of one second's worth go at once", () => {
    const bucket = new TokenBucket(BYTES_PER_SECOND, createClock().now);

    const waitMs = bucket.waitMs(1000);

    expect(waitMs).toBe(0);
  });

  it("makes a frame wait until the bucket refills enough for it", () => {
    const clock = createClock();
    const bucket = new TokenBucket(BYTES_PER_SECOND, clock.now);
    bucket.take(900);
    clock.advance(100);

    const waitMs = bucket.waitMs(500);

    expect(waitMs).toBe(300);
  });

  it("makes a frame larger than the bucket wait for a full bucket, then leaves it in debt", () => {
    const clock = createClock();
    const bucket = new TokenBucket(BYTES_PER_SECOND, clock.now);
    bucket.take(400);

    const fullWaitMs = bucket.waitMs(2500);
    clock.advance(fullWaitMs);
    bucket.take(2500);

    expect({ fullWaitMs, debtWaitMs: bucket.waitMs(100) }).toEqual({ fullWaitMs: 400, debtWaitMs: 1600 });
  });

  it("holds at most one second's worth however long it is idle", () => {
    const clock = createClock();
    const bucket = new TokenBucket(BYTES_PER_SECOND, clock.now);
    bucket.take(1000);
    clock.advance(60_000);
    bucket.take(1000);

    const waitMs = bucket.waitMs(1);

    expect(waitMs).toBe(1);
  });

  it.each([100, 700, 2500])("keeps the average within the limit over 10 s with %i-byte frames", (frameBytes) => {
    const sentBytes = sendAsFastAsAllowed(frameBytes, 10_000);

    // The first second's burst comes on top of 10 s at the limit; a frame larger than the bucket may add one frame
    expect(sentBytes).toBeLessThanOrEqual(BYTES_PER_SECOND * 11 + Math.max(0, frameBytes - BYTES_PER_SECOND));
    expect(sentBytes).toBeGreaterThan(BYTES_PER_SECOND * 10 - frameBytes);
  });
});
