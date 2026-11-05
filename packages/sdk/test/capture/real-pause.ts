// Reads a pause of the real V8 of the test process: a function with the given variables stops at a `debugger`
// statement, and the capture runs inside the pause, as it does in the app.

import type { CaptureLimits } from "@probex-platform/protocol";

import {
  readPause,
  type CaptureDependencies,
  type PausedLocation,
  type PauseRead,
} from "../../src/debugger/capture/index.js";
import { InspectorSession } from "../../src/debugger/index.js";
import { createLogger } from "../../src/logger/index.js";
import { createRecordingLogger, envOf, type LoggedLine } from "../debugger/fakes.js";
import { Fixtures, TracedSession } from "../debugger/real-v8.js";

/** What a run of the fixture function gave. */
export interface RealPause {
  read: PauseRead;
  /** The commands the capture sent, besides the resume. */
  commands: string[];
  /** Everything the debugger logged during the pause, at every level. */
  logged: LoggedLine[];
}

export interface RealPauseOptions {
  limits?: Array<CaptureLimits | undefined>;
  dependencies?: Partial<Omit<CaptureDependencies, "session">>;
  /** Source of the module, in which `body` replaces the placeholder `/* body *\/`. */
  module?: string;
}

const MODULE = `exports.pause = function run() {
/* body */
  debugger;
  return 1;
};
`;

const plainLocation = (spot: PausedLocation) => ({
  file: spot.scriptId,
  line: spot.lineNumber + 1,
  column: spot.columnNumber + 1,
});

/**
 * Runs `body`, the statements that declare the variables to read, in a function that pauses after them, and reads
 * the pause. The session is the real `node:inspector` one, so the replies are V8's own.
 */
export const readRealPause = (body: string, options: RealPauseOptions = {}): RealPause => {
  const fixtures = new Fixtures();
  const traced = new TracedSession();
  const logged: LoggedLine[] = [];
  const logger = createLogger({
    component: "debugger",
    env: envOf(["PROBEX_LOG_LEVEL", "debug"]),
    console: createRecordingLogger(logged),
  });
  const session = new InspectorSession(logger, traced);
  session.connect();
  session.post("Debugger.enable");
  let read: PauseRead | undefined;
  let failure: unknown;
  session.on("Debugger.paused", (params) => {
    try {
      read = readPause(params, options.limits ?? [undefined], {
        session,
        locateFrame: plainLocation,
        isSecret: () => false,
        ...options.dependencies,
      });
    } catch (error) {
      failure = error;
    } finally {
      session.post("Debugger.resume");
    }
  });

  try {
    const file = fixtures.write("pause.cjs", (options.module ?? MODULE).replace("/* body */", body));
    const pause = fixtures.loadPause(file);
    pause.pause();
  } finally {
    session.post("Debugger.disable");
    session.disconnect();
    fixtures.remove();
  }

  if (failure !== undefined) {
    throw failure instanceof Error ? failure : new Error("the capture failed");
  }

  if (read === undefined) {
    throw new Error("the fixture did not pause");
  }

  const commands = traced.methods.filter((method) => method.startsWith("Runtime."));
  return { read, commands, logged };
};
