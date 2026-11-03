import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRecordingLogger, FakeBreakpointsInspector, type LoggedLine } from "../../../../test/debugger/fakes.js";
import {
  CHECKOUT_SOURCE,
  createBreakpoints,
  DEBUGGER_STATEMENT_SOURCE,
  TOTAL_OF_TWO_ITEMS,
  TWO_ITEMS,
  type BreakpointsUnderTest,
} from "../../../../test/debugger/real-v8.js";
import { createLogger } from "../../../logger/index.js";
import { Breakpoints } from "../index.js";

let test: BreakpointsUnderTest;

beforeEach(() => {
  vi.useFakeTimers();
  test = createBreakpoints();
});

afterEach(() => {
  test.dispose();
  vi.useRealTimers();
});

// The lines held during a pause are written in a setImmediate after the thread resumes
const runImmediates = (): void => {
  vi.advanceTimersByTime(0);
};

const PAUSE_NOT_CAUSED = "resumed a pause that none of the breakpoints caused";

describe("Breakpoints pausing", () => {
  it("resumes the pause of one of its breakpoints and does not log it as foreign", () => {
    const module = test.fixtures.loadCheckout(test.fixtures.write("orders/checkout.cjs", CHECKOUT_SOURCE));
    test.apply({ id: "bp-1", file: test.fixtures.file("orders/checkout.cjs"), line: 6 });

    const total = module.total(TWO_ITEMS);
    runImmediates();

    expect({
      total,
      resumes: test.session.count("Debugger.resume"),
      foreign: test.messagesAt("debug").filter((line) => line === PAUSE_NOT_CAUSED),
    }).toEqual({ total: TOTAL_OF_TWO_ITEMS, resumes: 1, foreign: [] });
  });

  it("resumes a pause it did not cause and logs it at debug", () => {
    const module = test.fixtures.loadPause(test.fixtures.write("pause.cjs", DEBUGGER_STATEMENT_SOURCE));
    test.apply({ id: "bp-1", file: test.fixtures.file("orders/checkout.cjs"), line: 6 });

    const returned = module.pause();
    runImmediates();

    expect({ returned, foreign: test.messagesAt("debug").filter((line) => line === PAUSE_NOT_CAUSED) }).toEqual({
      returned: 1,
      foreign: [PAUSE_NOT_CAUSED],
    });
  });

  it("holds log lines while the thread is paused and writes them after it resumed", () => {
    const module = test.fixtures.loadPause(test.fixtures.write("pause.cjs", DEBUGGER_STATEMENT_SOURCE));
    test.apply({ id: "bp-1", file: test.fixtures.file("orders/checkout.cjs"), line: 6 });
    let linesWhenResumed: string[] = [];
    test.session.beforePost = (method) => {
      if (method === "Debugger.resume") {
        linesWhenResumed = test.messagesAt("debug");
      }
    };

    module.pause();
    const linesBeforeImmediate = test.messagesAt("debug");
    runImmediates();

    expect({
      whenResumed: linesWhenResumed.includes(PAUSE_NOT_CAUSED),
      beforeImmediate: linesBeforeImmediate.includes(PAUSE_NOT_CAUSED),
      afterImmediate: test.messagesAt("debug").includes(PAUSE_NOT_CAUSED),
    }).toEqual({ whenResumed: false, beforeImmediate: false, afterImmediate: true });
  });

  it("resumes the thread, disables the domain and reports when Debugger.resume fails", () => {
    const module = test.fixtures.loadCheckout(test.fixtures.write("orders/checkout.cjs", CHECKOUT_SOURCE));
    test.apply({ id: "bp-1", file: test.fixtures.file("orders/checkout.cjs"), line: 6 });
    test.session.failing.add("Debugger.resume");

    const total = module.total(TWO_ITEMS);

    expect({
      total,
      disables: test.session.count("Debugger.disable"),
      failures: test.failures.map((failure) => (failure as Error).message),
    }).toEqual({ total: TOTAL_OF_TWO_ITEMS, disables: 1, failures: ["Debugger.resume failed"] });
  });
});

// A scriptParsed whose url getter throws: an unexpected error inside the handler
const throwingScript = (): object =>
  Object.defineProperty({}, "url", {
    get: () => {
      throw new Error("url getter failed");
    },
  });

describe("Breakpoints reading inspector events", () => {
  const createOnFake = () => {
    const inspector = new FakeBreakpointsInspector();
    const lines: LoggedLine[] = [];
    const logger = createLogger({ component: "debugger", env: {}, console: createRecordingLogger(lines) });
    logger.set({ logLevel: "debug" }, "debugger");
    const failures: unknown[] = [];
    const sent: unknown[] = [];
    const breakpoints: Breakpoints = new Breakpoints({
      session: inspector,
      logger,
      send: (status) => {
        sent.push(status);
      },
      // As the debugger does: an unexpected error stops it
      fail: (error) => {
        failures.push(error);
        breakpoints.stop();
      },
    });
    breakpoints.start();
    return { inspector, lines, failures, sent, breakpoints };
  };

  it.each([
    ["no params", undefined],
    ["no hitBreakpoints", { reason: "other" }],
    ["hitBreakpoints that is not an array", { hitBreakpoints: "1:3:0:file" }],
    ["ids that are not strings", { hitBreakpoints: [7, null] }],
  ])("resumes a pause with %s and logs it as one it did not cause", (_name, params) => {
    const { inspector, lines } = createOnFake();

    inspector.emit("Debugger.paused", params);
    runImmediates();

    expect({ posted: inspector.posted, lines }).toEqual({
      posted: ["Debugger.resume"],
      lines: [{ level: "debug", message: PAUSE_NOT_CAUSED }],
    });
  });

  it("reports an unexpected error in a scriptParsed handler instead of throwing into the inspector", () => {
    const { inspector, failures } = createOnFake();

    inspector.emit("Debugger.scriptParsed", throwingScript());

    expect(failures.map((failure) => (failure as Error).message)).toEqual(["url getter failed"]);
  });

  it("sets nothing and sends no status when a scriptParsed handler stops it while the domain turns on", () => {
    const { inspector, sent, breakpoints } = createOnFake();
    inspector.onPost = (method) => {
      if (method === "Debugger.enable") {
        inspector.emit("Debugger.scriptParsed", throwingScript());
      }
    };

    breakpoints.apply({ version: 1, type: "breakpoints", breakpoints: [{ id: "bp-1", file: "a.js", line: 1 }] });

    expect({ posted: inspector.posted, sent }).toEqual({ posted: ["Debugger.enable"], sent: [] });
  });
});
