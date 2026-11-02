import { describe, expect, it } from "vitest";

import { Fifo } from "./fifo.js";

const createFifo = (items: readonly string[]): Fifo<string> => {
  const fifo = new Fifo<string>();
  for (const item of items) {
    fifo.push(item);
  }

  return fifo;
};

describe("Fifo", () => {
  it("returns items in the order they were pushed, across compactions", () => {
    const fifo = createFifo(["a", "b", "c", "d", "e"]);

    const taken = [fifo.shift(), fifo.shift(), fifo.shift()];
    fifo.push("f");

    expect({ taken, rest: [...fifo], size: fifo.size }).toEqual({
      taken: ["a", "b", "c"],
      rest: ["d", "e", "f"],
      size: 3,
    });
  });

  it("returns undefined from an empty queue and keeps working after it", () => {
    const fifo = createFifo(["a"]);
    fifo.shift();

    const empty = fifo.shift();
    fifo.push("b");

    expect({ empty, rest: [...fifo], size: fifo.size }).toEqual({ empty: undefined, rest: ["b"], size: 1 });
  });
});
