import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeCompiled } from "../../../../test/debugger/compiled.js";
import {
  CHECKOUT_SOURCE,
  createBreakpoints,
  TWO_ITEMS,
  type BreakpointsUnderTest,
} from "../../../../test/debugger/real-v8.js";

let test: BreakpointsUnderTest;

beforeEach(() => {
  test = createBreakpoints();
});

afterEach(() => {
  test.dispose();
});

interface Spot {
  scriptId: string;
  lineNumber: number;
  columnNumber: number;
}

// The place of the innermost frame of the first pause, which Breakpoints resumes before the test looks at it
const recordFirstPause = (): { spot: () => Spot } => {
  let first: Spot | undefined;
  test.session.on("Debugger.paused", (message) => {
    const frames: unknown = Reflect.get(message.params as object, "callFrames");
    const location: unknown = Array.isArray(frames) ? Reflect.get(frames[0] as object, "location") : undefined;
    first ??= location as Spot;
  });
  return {
    spot: () => {
      if (first === undefined) {
        throw new Error("the fixture did not pause");
      }

      return first;
    },
  };
};

describe("Breakpoints.locateFrame", () => {
  it("gives the original TypeScript path and position of a frame in a script with a decoded map", async () => {
    const compiled = writeCompiled(test.fixtures, "checkout");
    const module = test.fixtures.loadCheckout(compiled.script);
    const pause = recordFirstPause();
    test.apply({ id: "bp-1", file: compiled.file, line: 8 });
    await test.waitForLine("debug", "source map loaded: ");

    module.total(TWO_ITEMS);
    const located = test.breakpoints.locateFrame(pause.spot());

    expect({ endsWithOriginal: located.file.endsWith(`/${compiled.file}`), line: located.line }).toEqual({
      endsWithOriginal: true,
      line: 8,
    });
  });

  it("gives the generated path and 1-based position of a frame in a script without a map", () => {
    const file = test.fixtures.write("orders/checkout.cjs", CHECKOUT_SOURCE);
    const module = test.fixtures.loadCheckout(file);
    const pause = recordFirstPause();
    test.apply({ id: "bp-1", file: test.fixtures.file("orders/checkout.cjs"), line: 4 });

    module.total(TWO_ITEMS);
    const located = test.breakpoints.locateFrame(pause.spot());

    expect(located).toEqual({ file: file.replaceAll("\\", "/"), line: 4, column: 17 });
  });

  it("gives <anonymous> for a script id it does not know", () => {
    test.apply({ id: "bp-1", file: "src/none.ts", line: 1 });

    const located = test.breakpoints.locateFrame({ scriptId: "999999", lineNumber: 2, columnNumber: 4 });

    expect(located).toEqual({ file: "<anonymous>", line: 3, column: 5 });
  });
});
