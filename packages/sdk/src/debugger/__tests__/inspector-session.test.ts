import { Session, url } from "node:inspector";
import { isMainThread } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";

import { createRecordingLogger, FakeInspectorBinding, type LoggedLine } from "../../../test/debugger/fakes.js";
import { createLogger } from "../../logger/index.js";
import { InspectorSession, type InspectorBinding, type InspectorResult } from "../inspector-session.js";

const sessions: InspectorSession[] = [];

const createSession = (binding: InspectorBinding = new Session(), lines: LoggedLine[] = []): InspectorSession => {
  const logger = createLogger({ component: "debugger", env: {}, console: createRecordingLogger(lines) });
  const session = new InspectorSession(logger, binding);
  sessions.push(session);
  return session;
};

const valueOf = (answer: object): unknown => Reflect.get(Reflect.get(answer, "result") as object, "value");

const errorCodeOf = (result: InspectorResult): unknown => (result.ok ? undefined : Reflect.get(result.error, "code"));

afterEach(() => {
  for (const session of sessions.splice(0)) {
    session.disconnect();
  }
});

describe("InspectorSession with node:inspector", () => {
  it("runs on a main thread, where a session answers synchronously", () => {
    expect(isMainThread).toBe(true);
  });

  it("returns the answer of a command before post() returns", () => {
    const session = createSession();
    session.connect();

    const answer = session.post("Runtime.evaluate", { expression: "6 * 7" });

    expect(answer.ok && valueOf(answer.value)).toBe(42);
  });

  it("returns an error instead of throwing when not connected", () => {
    const session = createSession();

    const answer = session.post("Runtime.evaluate", { expression: "1" });

    expect(errorCodeOf(answer)).toBe("ERR_INSPECTOR_NOT_CONNECTED");
  });

  it("returns an error when the command fails", () => {
    const session = createSession();
    session.connect();

    const answer = session.post("Runtime.noSuchMethod");

    expect(answer.ok).toBe(false);
  });

  it("returns an error when connect() is called twice", () => {
    const session = createSession();
    session.connect();

    const second = session.connect();

    expect(errorCodeOf(second)).toBe("ERR_INSPECTOR_ALREADY_CONNECTED");
  });

  it("answers while the thread is paused", () => {
    const session = createSession();
    session.connect();
    session.post("Debugger.enable");
    let answerWhilePaused: unknown;
    session.on("Debugger.paused", (params) => {
      try {
        const [frame] = Reflect.get(params as object, "callFrames") as Array<{ callFrameId: string }>;
        const answer = session.post("Debugger.evaluateOnCallFrame", {
          callFrameId: frame?.callFrameId,
          expression: "40 + 2",
        });
        answerWhilePaused = answer.ok && valueOf(answer.value);
      } finally {
        session.post("Debugger.resume");
      }
    });

    session.post("Runtime.evaluate", { expression: "debugger;" });

    expect(answerWhilePaused).toBe(42);
  });

  it("disconnects, after which commands return errors", () => {
    const session = createSession();
    session.connect();

    session.disconnect();

    expect(session.post("Runtime.evaluate", { expression: "1" }).ok).toBe(false);
  });

  it("coexists with the coverage session, while no inspector port is open", () => {
    const first = createSession();
    const second = createSession();
    first.connect();
    second.connect();

    const answers = [first, second].map((session) => session.post("Runtime.evaluate", { expression: "1" }).ok);

    expect({ answers, url: url() }).toEqual({ answers: [true, true], url: undefined });
  });
});

describe("InspectorSession events", () => {
  it("calls a handler with the params of its event", () => {
    const binding = new FakeInspectorBinding();
    const session = createSession(binding);
    const received: unknown[] = [];
    session.on("Debugger.scriptParsed", (params) => received.push(params));

    binding.emit("Debugger.scriptParsed", { method: "Debugger.scriptParsed", params: { scriptId: "42" } });

    expect(received).toEqual([{ scriptId: "42" }]);
  });

  it("stops calling a handler after its unsubscribe function runs", () => {
    const binding = new FakeInspectorBinding();
    const session = createSession(binding);
    const received: unknown[] = [];
    const unsubscribe = session.on("Debugger.scriptParsed", (params) => received.push(params));

    unsubscribe();
    binding.emit("Debugger.scriptParsed", { method: "Debugger.scriptParsed", params: { scriptId: "42" } });

    expect(received).toEqual([]);
  });

  it("logs a handler that throws at error and keeps calling the others", () => {
    const binding = new FakeInspectorBinding();
    const lines: LoggedLine[] = [];
    const session = createSession(binding, lines);
    const received: unknown[] = [];
    session.on("Debugger.scriptParsed", () => {
      throw new TypeError("handler failed");
    });
    session.on("Debugger.scriptParsed", (params) => received.push(params));

    binding.emit("Debugger.scriptParsed", { method: "Debugger.scriptParsed", params: { scriptId: "42" } });

    expect({ lines, received }).toEqual({
      lines: [{ level: "error", message: "a handler of Debugger.scriptParsed threw" }],
      received: [{ scriptId: "42" }],
    });
  });
});

describe("InspectorSession with a failing binding", () => {
  it("returns an error when the binding does not answer inside post()", () => {
    const binding = new FakeInspectorBinding();
    binding.post = () => undefined;
    const session = createSession(binding);
    session.connect();

    const answer = session.post("Runtime.evaluate");

    expect(answer).toEqual({ ok: false, error: new Error("the inspector did not answer synchronously") });
  });

  it("returns an error when connect() throws", () => {
    const session = createSession(new FakeInspectorBinding(new Error("inspector unavailable")));

    const answer = session.connect();

    expect(answer).toEqual({ ok: false, error: new Error("inspector unavailable") });
  });

  it("logs a warning when disconnect() throws", () => {
    const binding = new FakeInspectorBinding();
    binding.disconnect = () => {
      throw new Error("already gone");
    };
    const lines: LoggedLine[] = [];
    const session = createSession(binding, lines);
    session.connect();

    session.disconnect();

    expect(lines).toEqual([{ level: "warn", message: "the inspector session did not disconnect cleanly" }]);
  });
});

describe("InspectorSession with a misbehaving binding", () => {
  it("returns an Error when the binding fails with a value that is not one", () => {
    const binding = new FakeInspectorBinding();
    binding.post = (_method, _params, callback) => {
      callback("protocol failure" as unknown as Error);
    };
    const session = createSession(binding);

    const answer = session.post("Runtime.evaluate");

    expect(answer).toEqual({ ok: false, error: new Error("the inspector failed with a value that is not an Error") });
  });

  it("logs an error and returns a safe unsubscribe when subscribing throws", () => {
    const binding = new FakeInspectorBinding();
    binding.on = () => {
      throw new Error("no listeners");
    };
    binding.off = () => {
      throw new Error("no listeners");
    };
    const lines: LoggedLine[] = [];
    const session = createSession(binding, lines);

    const unsubscribe = session.on("Debugger.paused", () => undefined);

    expect(unsubscribe).not.toThrow();
    expect(lines).toEqual([{ level: "error", message: "could not subscribe to Debugger.paused" }]);
  });

  it("does nothing when disconnect() is called before connect()", () => {
    const binding = new FakeInspectorBinding();
    binding.disconnect = () => {
      throw new Error("not connected");
    };
    const lines: LoggedLine[] = [];
    const session = createSession(binding, lines);

    session.disconnect();

    expect(lines).toEqual([]);
  });
});
