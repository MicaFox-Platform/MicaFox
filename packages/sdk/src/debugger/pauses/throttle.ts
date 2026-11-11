import type { SdkLogger } from "../../logger/index.js";
import type { RateLimiter } from "../rate-limiter/index.js";

const COMPONENT = "debugger";

/** The commands the throttle sends to V8; an `InspectorSession` answers them and never throws. */
export interface ThrottleInspector {
  post(method: string, params?: object): { ok: true; value: object } | { ok: false; error: Error };
}

/** What the throttle needs from `Breakpoints`: entries taken off for a rate limit and set again. */
export interface ThrottledBreakpoints {
  rateLimit(ids: readonly string[]): void;
  rateLimitAll(): void;
  rateLimitedIds(): string[];
  /** Whether `rateLimitAll()` turned every entry off and no `restore(..., "all")` ended it yet. */
  isAllRateLimited(): boolean;
  /** Returns the entries that are `active` again. */
  restore(ids: readonly string[], scope: "entries" | "all"): string[];
}

/** What `Throttle` needs from the debugger. */
export interface ThrottleDependencies {
  session: ThrottleInspector;
  logger: SdkLogger;
  breakpoints: ThrottledBreakpoints;
  limiter: RateLimiter;
  /** Reports an unexpected error from the timer: the debugger stops itself. */
  fail: (error: unknown) => void;
}

/** The inspector refused to turn the breakpoints off or on, so the rate limits cannot hold. */
class ThrottleError extends Error {
  override readonly name = "ThrottleError";
}

/**
 * Takes breakpoints off when a rate limit runs out and sets them again when it is full, with one unref'd timer
 * (docs/architecture/sdk/debugger.md#capturing-a-snapshot). An entry out of its own tokens leaves its V8 breakpoint;
 * a spent process bucket or budget turns every breakpoint off with `Debugger.setBreakpointsActive`.
 */
export class Throttle {
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly dependencies: ThrottleDependencies) {}

  /** Takes off the entries out of tokens, and every breakpoint once the process's limits are spent. */
  afterPause(outOfTokens: readonly string[]): void {
    const { breakpoints, limiter } = this.dependencies;
    breakpoints.rateLimit(outOfTokens);
    if (!breakpoints.isAllRateLimited() && limiter.isSpent()) {
      this.setAllActive(false);
      breakpoints.rateLimitAll();
    }

    if (outOfTokens.length > 0 || breakpoints.isAllRateLimited()) {
      this.schedule();
    }
  }

  /** Clears the timer; the debugger is stopping. */
  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  // One timer, set to the nearest wait; when it fires it restores what is due and is set again for the rest. While
  // every breakpoint is off nothing pauses, so it waits for every bucket and the budget to be full
  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const waitMs = this.nextWaitMs();
    if (waitMs === undefined) {
      return;
    }

    this.timer = setTimeout(
      () => {
        this.onTimer();
      },
      Math.max(1, Math.ceil(waitMs)),
    );
    this.timer.unref();
  }

  private nextWaitMs(): number | undefined {
    const { breakpoints, limiter } = this.dependencies;
    const waits = breakpoints.rateLimitedIds().map((id) => limiter.msUntilEntryFull(id));
    if (breakpoints.isAllRateLimited()) {
      return Math.max(limiter.msUntilProcessFull(), ...waits);
    }

    return waits.length === 0 ? undefined : Math.min(...waits);
  }

  private onTimer(): void {
    this.timer = undefined;
    try {
      this.restoreDue();
      this.schedule();
    } catch (error) {
      this.dependencies.fail(error);
    }
  }

  private restoreDue(): void {
    const { breakpoints, limiter, logger } = this.dependencies;
    const wasAllOff = breakpoints.isAllRateLimited();
    if (wasAllOff) {
      if ((this.nextWaitMs() ?? 0) > 0) {
        return;
      }

      this.setAllActive(true);
    }

    const due = breakpoints.rateLimitedIds().filter((id) => limiter.msUntilEntryFull(id) === 0);
    if (due.length === 0 && !wasAllOff) {
      return;
    }

    // The process's limits ending is worth a line; a hot line refilling every second is not
    const active = breakpoints.restore(due, wasAllOff ? "all" : "entries");
    const what = wasAllOff ? "the process's rate limits" : "rate limits";
    logger.log(wasAllOff ? "info" : "debug", `${what} refilled; ${String(active.length)} breakpoints active again`, {
      component: COMPONENT,
    });
  }

  private setAllActive(active: boolean): void {
    const answer = this.dependencies.session.post("Debugger.setBreakpointsActive", { active });
    if (!answer.ok) {
      const action = active ? "on" : "off";
      throw new ThrottleError(`the inspector could not turn the breakpoints ${action}`, { cause: answer.error });
    }
  }
}
