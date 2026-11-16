import { describe, expect, it } from "vitest";

import { ReadQueue } from "../read-queue.js";

describe("ReadQueue", () => {
  it("gives every read by name before any read for a search, each in the order asked for", () => {
    const queue = new ReadQueue<string>();
    queue.push("search", "bundle-1");
    queue.push("name", "checkout-1");
    queue.push("search", "bundle-2");
    queue.push("name", "checkout-2");

    const taken = [queue.take(), queue.take(), queue.take(), queue.take(), queue.take()];

    expect(taken).toEqual(["checkout-1", "checkout-2", "bundle-1", "bundle-2", undefined]);
  });

  it("takes a read pushed after the lanes ran empty", () => {
    const queue = new ReadQueue<string>();
    queue.push("name", "checkout-1");
    queue.take();
    queue.take();

    queue.push("search", "bundle-1");

    expect(queue.take()).toBe("bundle-1");
  });

  it("keeps the order of a lane that is pushed to while it is taken from", () => {
    const queue = new ReadQueue<number>();
    const taken: Array<number | undefined> = [];
    for (let next = 0; next < 10; next += 1) {
      queue.push("name", next);
      queue.push("name", next + 100);
      taken.push(queue.take());
    }

    while (taken.length < 20) {
      taken.push(queue.take());
    }

    expect(taken).toEqual([0, 100, 1, 101, 2, 102, 3, 103, 4, 104, 5, 105, 6, 106, 7, 107, 8, 108, 9, 109]);
  });

  it("is empty after clear", () => {
    const queue = new ReadQueue<string>();
    queue.push("name", "checkout-1");
    queue.push("search", "bundle-1");

    queue.clear();

    expect(queue.take()).toBeUndefined();
  });
});
