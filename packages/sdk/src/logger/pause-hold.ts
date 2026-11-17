import { LineQueue, type HeldLine, type TakenLines } from "./line-queue.js";

// Shared by every logger in the process, whatever copy or version of the SDK created it: the ES module and CommonJS
// builds, and two installs of the package, find each other through the registry key
const HOLD_KEY = Symbol.for("micafox.logger.hold");

type Drain = () => void;

/** The process-wide state of a pause: the flag, and the loggers that hold lines waiting for it to end. */
interface HoldRecord {
  held: boolean;
  drains: Set<Drain>;
}

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;

// Claims, without checking, that the elements are drains: one of another copy may be anything, which is why every
// drain is called inside its own `try`
const isDrainSet = (value: unknown): value is Set<Drain> => value instanceof Set;

// The readers below take whatever is on `globalThis`: another copy of the SDK may have written a record of an older
// or newer shape, and a getter may throw. They never create anything, so a line costs one lookup.
const isHeld = (): boolean => {
  try {
    const record: unknown = Reflect.get(globalThis, HOLD_KEY);
    return isObject(record) && Reflect.get(record, "held") === true;
  } catch {
    return false;
  }
};

const findDrains = (): Set<Drain> | undefined => {
  try {
    const record: unknown = Reflect.get(globalThis, HOLD_KEY);
    const drains: unknown = isObject(record) ? Reflect.get(record, "drains") : undefined;
    return isDrainSet(drains) ? drains : undefined;
  } catch {
    return undefined;
  }
};

// Keeps an existing record, so a flag another copy set stays in force, and adds only what it lacks. A `drains` field
// of another shape stays as it is: this logger's queue is then written only by its own release(), next line or flush()
const openRecord = (): object => {
  const existing: unknown = Reflect.get(globalThis, HOLD_KEY);
  if (isObject(existing)) {
    return existing;
  }

  const created: HoldRecord = { held: false, drains: new Set() };
  Reflect.set(globalThis, HOLD_KEY, created);
  return created;
};

const openDrains = (): Set<Drain> => {
  const record = openRecord();
  const existing: unknown = Reflect.get(record, "drains");
  if (isDrainSet(existing)) {
    return existing;
  }

  const created = new Set<Drain>();
  if (existing === undefined) {
    Reflect.set(record, "drains", created);
  }
  return created;
};

/**
 * Holds the lines of one logger while the thread is paused, so the app's logger never runs inside a pause. The pause
 * is one flag for the whole process; each logger keeps its own queue and registers it for the end of the pause.
 */
export class PauseHold {
  private readonly queue = new LineQueue();
  private immediate: NodeJS.Immediate | undefined;

  /** `writeTaken` writes what the queue held, once the pause is over. */
  constructor(private readonly writeTaken: (taken: TakenLines) => void) {}

  /** Tells whether a line must wait: the thread is paused, or earlier lines still wait, and order must hold. */
  shouldQueue(): boolean {
    return this.queue.length > 0 || isHeld();
  }

  enqueue(line: HeldLine): void {
    this.queue.push(line);
    try {
      openDrains().add(this.drain);
      if (!isHeld()) {
        // Queued only to keep the order: another copy may have cleared the flag without draining this queue
        this.immediate ??= setImmediate(this.onImmediate);
      }
    } catch {
      // The record is unusable: the lines wait for this logger's own flush() or next line after the pause
    }
  }

  /** Starts a pause for every logger in the process; a second call does nothing. */
  hold(): void {
    try {
      Reflect.set(openRecord(), "held", true);
    } catch {
      // A public method never throws; a global that cannot be written means no pause is held
    }
  }

  /** Ends the pause; the lines are written in a `setImmediate`, after the thread resumes. */
  release(): void {
    try {
      if (!isHeld()) {
        return;
      }

      Reflect.set(openRecord(), "held", false);
      this.immediate ??= setImmediate(this.onImmediate);
    } catch {
      // A public method never throws
    }
  }

  /** Writes the queue now, unless the thread is paused; then it stays for `release()`. */
  flush(): void {
    if (isHeld()) {
      return;
    }

    this.drain();
    // The immediate also serves the queues of other loggers: it stays while any of them waits
    if (this.immediate !== undefined && (findDrains()?.size ?? 0) === 0) {
      clearImmediate(this.immediate);
      this.immediate = undefined;
    }
  }

  private readonly drain = (): void => {
    if (isHeld()) {
      return;
    }

    findDrains()?.delete(this.drain);
    this.writeTaken(this.queue.take());
  };

  // Not unref'd: the lines of a pause are written even when the app is about to exit
  private readonly onImmediate = (): void => {
    this.immediate = undefined;
    // A copy, because a drain removes itself from the set; this logger's own drain runs too when the record lost it
    const drains = new Set([...(findDrains() ?? []), this.drain]);
    for (const drain of drains) {
      try {
        drain();
      } catch {
        // A timer callback is a boundary: nothing may reach the host app, and a failing drain of another copy must
        // not keep the others waiting
      }
    }
  };
}
