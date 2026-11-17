/** Reports a handler that threw or rejected. */
export type ReportHandlerError = (error: unknown) => void;

// Typed to return `unknown`: a handler declared `void` may still return a promise, whose rejection is reported
type Handler<T> = (value: T) => unknown;

interface Entry<T> {
  readonly handler: Handler<T>;
}

const reportRejection = (result: unknown, report: ReportHandlerError): void => {
  if (result === null || (typeof result !== "object" && typeof result !== "function")) {
    return;
  }

  // An async handler that rejects would otherwise be an unhandled rejection in the host app
  const then: unknown = Reflect.get(result, "then");
  if (typeof then === "function") {
    Reflect.apply(then, result, [undefined, report]);
  }
};

/** The handlers of one event, called in the order they subscribed. */
export class HandlerList<T> {
  private entries: ReadonlyArray<Entry<T>> = [];

  constructor(private readonly report: ReportHandlerError) {}

  /** Adds `handler`; the returned function removes this registration only, and does nothing a second time. */
  add(handler: Handler<T>): () => void {
    // A wrapper per registration: the same function added twice is two entries, removed one at a time
    const entry: Entry<T> = { handler };
    this.entries = [...this.entries, entry];
    return () => {
      this.entries = this.entries.filter((candidate) => candidate !== entry);
    };
  }

  /** Calls every handler with `value`; one that throws or rejects is reported and the others still run. */
  call(value: T): void {
    // Iterates a snapshot, so a handler that removes itself or another does not skip anyone
    for (const { handler } of this.entries) {
      try {
        const result = handler(value);
        reportRejection(result, this.report);
      } catch (error) {
        this.report(error);
      }
    }
  }

  /** Removes every handler. */
  clear(): void {
    this.entries = [];
  }
}
