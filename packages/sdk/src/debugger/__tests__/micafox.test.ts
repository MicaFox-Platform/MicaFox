import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { MicafoxDebugger } from "../debugger.js";
import { micafox, SDK_MAJOR, shareDebugger } from "../micafox.js";

const DEBUGGER_KEY = Symbol.for("micafox.debugger");
const MAJOR_KEY = Symbol.for("micafox.debugger.major");

// A stand-in for globalThis, so each test starts with a process that has no debugger
const createHolder = (slots: Record<symbol, unknown> = {}): Record<symbol, unknown> => ({ ...slots });

describe("shareDebugger", () => {
  it("creates the debugger and stores it with this copy's major version", () => {
    const holder = createHolder();
    const warnings: string[] = [];

    const shared = shareDebugger(
      holder,
      () => new MicafoxDebugger(),
      (message) => warnings.push(message),
    );

    expect({ stored: holder[DEBUGGER_KEY] === shared, major: holder[MAJOR_KEY], warnings }).toEqual({
      stored: true,
      major: SDK_MAJOR,
      warnings: [],
    });
  });

  it("gives a second copy the debugger the first one stored, without a warning", () => {
    const holder = createHolder();
    const warnings: string[] = [];
    const first = shareDebugger(
      holder,
      () => new MicafoxDebugger(),
      (message) => warnings.push(message),
    );

    const second = shareDebugger(
      holder,
      () => new MicafoxDebugger(),
      (message) => warnings.push(message),
    );

    expect({ isSame: second === first, warnings }).toEqual({ isSame: true, warnings: [] });
  });

  it.each([
    ["another major version", SDK_MAJOR + 1, `major version ${String(SDK_MAJOR + 1)}, already created`],
    ["no recorded version", undefined, "major version unknown, already created"],
  ])("warns and still uses the stored debugger of %s", (_name, major, expected) => {
    const stored = new MicafoxDebugger();
    const holder = createHolder({ [DEBUGGER_KEY]: stored, [MAJOR_KEY]: major });
    const warnings: string[] = [];

    const shared = shareDebugger(
      holder,
      () => new MicafoxDebugger(),
      (message) => warnings.push(message),
    );

    expect({ isStored: shared === stored, warnings: warnings.map((message) => message.includes(expected)) }).toEqual({
      isStored: true,
      warnings: [true],
    });
  });

  it("replaces a value under the key that is not a debugger", () => {
    const holder = createHolder({ [DEBUGGER_KEY]: { run: () => undefined } });

    const shared = shareDebugger(
      holder,
      () => new MicafoxDebugger(),
      () => undefined,
    );

    expect(holder[DEBUGGER_KEY]).toBe(shared);
  });

  it("gives this copy its own debugger and warns when the holder cannot be written", () => {
    const holder = Object.freeze(createHolder());
    const warnings: string[] = [];

    const shared = shareDebugger(
      holder,
      () => new MicafoxDebugger(),
      (message) => warnings.push(message),
    );

    expect({ isDebugger: shared instanceof MicafoxDebugger, count: warnings.length }).toEqual({
      isDebugger: true,
      count: 1,
    });
  });
});

describe("micafox", () => {
  it("is the debugger stored on globalThis", () => {
    expect(Reflect.get(globalThis, DEBUGGER_KEY)).toBe(micafox);
  });

  it("is a Debugger", () => {
    expect(micafox).toBeInstanceOf(MicafoxDebugger);
  });
});

describe("SDK_MAJOR", () => {
  it("equals the major version in package.json", () => {
    const manifest = JSON.parse(readFileSync(path.join(import.meta.dirname, "../../../package.json"), "utf8")) as {
      version: string;
    };

    expect(String(SDK_MAJOR)).toBe(manifest.version.split(".")[0]);
  });
});
