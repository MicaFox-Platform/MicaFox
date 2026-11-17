import { MicafoxDebugger, type Debugger } from "./debugger.js";
import { createLogger } from "../logger/index.js";

/** The major version of this copy of the SDK; a test keeps it equal to the major in `package.json`. */
export const SDK_MAJOR = 0;

const DEBUGGER_KEY: unique symbol = Symbol.for("micafox.debugger");
// Beside the debugger, so a later copy can tell which major version stored it; the `Debugger` type gets no member
const MAJOR_KEY: unique symbol = Symbol.for("micafox.debugger.major");

type Warn = (message: string) => void;

const DEBUGGER_METHODS = ["configure", "run", "stop"];

// Anything else under the key is not ours: another library, or a copy that is not a debugger
const isDebugger = (value: unknown): value is Debugger => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return DEBUGGER_METHODS.every((name) => typeof Reflect.get(value, name) === "function");
};

const describeMajor = (major: unknown): string => (typeof major === "number" ? String(major) : "unknown");

// Reads the debugger a copy stored before, warning when its major version differs; `undefined` when there is none
const findStored = (holder: object, warn: Warn): Debugger | undefined => {
  const stored: unknown = Reflect.get(holder, DEBUGGER_KEY);
  if (!isDebugger(stored)) {
    return undefined;
  }

  const major: unknown = Reflect.get(holder, MAJOR_KEY);
  if (major !== SDK_MAJOR) {
    warn(
      `another copy of the SDK, major version ${describeMajor(major)}, already created the debugger; ` +
        `this copy, major version ${String(SDK_MAJOR)}, uses it`,
    );
  }

  return stored;
};

/**
 * Returns the debugger stored in `holder` by the first copy of the SDK, or creates one and stores it: one per process
 * (docs/architecture/sdk/debugger.md#boundaries). A copy of another major version warns and still uses the stored one.
 * A holder that cannot be read or written gives this copy its own debugger and a warning.
 */
export const shareDebugger = (holder: object, create: () => Debugger, warn: Warn): Debugger => {
  let created: Debugger | undefined;
  try {
    const stored = findStored(holder, warn);
    if (stored !== undefined) {
      return stored;
    }

    created = create();
    // The debugger first, so a failed write leaves no version without a debugger beside it; configurable, so a later
    // copy can replace a value that is not a debugger
    Object.defineProperty(holder, DEBUGGER_KEY, { value: created, configurable: true });
    Object.defineProperty(holder, MAJOR_KEY, { value: SDK_MAJOR, configurable: true });
    return created;
  } catch {
    warn("the debugger could not be shared through globalThis; this copy of the SDK uses its own");
    return created ?? create();
  }
};

const logger = createLogger({ component: "debugger" });

/** The debugger of this process, shared by every copy of the SDK. */
export const micafox: Debugger = shareDebugger(
  globalThis,
  () => new MicafoxDebugger(),
  (message) => {
    logger.log("warn", message, { component: "debugger" });
  },
);
