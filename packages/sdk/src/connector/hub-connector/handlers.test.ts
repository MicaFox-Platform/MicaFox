import { describe, expect, it } from "vitest";

import { HandlerList } from "./handlers.js";

const createList = (): { list: HandlerList<string>; reported: unknown[]; calls: string[] } => {
  const reported: unknown[] = [];
  return { list: new HandlerList<string>((error) => reported.push(error)), reported, calls: [] };
};

describe("HandlerList", () => {
  it("calls handlers in the order they were added", () => {
    const { list, calls } = createList();
    list.add((value) => calls.push(`first:${value}`));
    list.add((value) => calls.push(`second:${value}`));

    list.call("connected");

    expect(calls).toEqual(["first:connected", "second:connected"]);
  });

  it("stops calling a handler after its remover runs", () => {
    const { list, calls } = createList();
    const remove = list.add((value) => calls.push(value));

    remove();
    list.call("connected");

    expect(calls).toEqual([]);
  });

  it("removes one registration of a handler added twice, and nothing on a second call of its remover", () => {
    const { list, calls } = createList();
    const handler = (value: string): void => {
      calls.push(value);
    };
    const remove = list.add(handler);
    list.add(handler);

    remove();
    remove();
    list.call("connected");

    expect(calls).toEqual(["connected"]);
  });

  it("still calls a handler that an earlier one removes during the same call", () => {
    const { list, calls } = createList();
    let removeSecond = (): void => undefined;
    list.add(() => {
      removeSecond();
    });
    removeSecond = list.add((value) => calls.push(value));

    list.call("connected");

    expect(calls).toEqual(["connected"]);
  });

  it("reports a handler that throws and still calls the others", () => {
    const { list, reported, calls } = createList();
    const failure = new Error("handler failed");
    list.add(() => {
      throw failure;
    });
    list.add((value) => calls.push(value));

    list.call("connected");

    expect({ reported, calls }).toEqual({ reported: [failure], calls: ["connected"] });
  });

  it("reports a handler whose promise rejects", async () => {
    const { list, reported } = createList();
    const failure = new Error("async handler failed");
    list.add(() => Promise.reject(failure));

    list.call("connected");
    await Promise.resolve();

    expect(reported).toEqual([failure]);
  });

  it("calls no handler after clear()", () => {
    const { list, calls } = createList();
    list.add((value) => calls.push(value));

    list.clear();
    list.call("connected");

    expect(calls).toEqual([]);
  });
});
