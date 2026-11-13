import { describe, expect, it } from "vitest";

import { createRecordingLogger, FakeBreakpointsInspector } from "../../../../test/debugger/fakes.js";
import { createLogger } from "../../../logger/index.js";
import { Breakpoints } from "../index.js";

// A scriptParsed whose url getter throws: an unexpected error inside the handler
const throwingScript = (): object =>
  Object.defineProperty({}, "url", {
    get: () => {
      throw new Error("url getter failed");
    },
  });

describe("Breakpoints reading scriptParsed events", () => {
  const createOnFake = () => {
    const inspector = new FakeBreakpointsInspector();
    const logger = createLogger({ component: "debugger", env: {}, console: createRecordingLogger([]) });
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
      onRemoved: () => undefined,
    });
    breakpoints.start();
    return { inspector, failures, sent, breakpoints };
  };

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

    breakpoints.apply({
      version: 1,
      module: "debugger",
      type: "breakpoints",
      breakpoints: [{ id: "bp-1", file: "a.js", line: 1 }],
    });

    expect({ posted: inspector.posted, sent }).toEqual({ posted: ["Debugger.enable"], sent: [] });
  });
});
