import type { V8Inspector } from "./v8-breakpoints.js";
import type { SdkLogger } from "../../logger/index.js";
import { ScriptRegistry, type ScriptRecord } from "../location/index.js";

const COMPONENT = "debugger";

/** The inspector session as the domain uses it; an `InspectorSession` fits. */
export interface DomainInspector extends V8Inspector {
  /** Calls `handler` with the params of every `event`; returns a function that stops it. */
  on(event: string, handler: (params: unknown) => void): () => void;
}

/** What the domain needs from `Breakpoints`. */
export interface DomainDependencies {
  session: DomainInspector;
  logger: SdkLogger;
  /** Whether the debugger is stopping: a `scriptParsed` handler can stop it inside the command that turns the domain on. */
  isStopped: () => boolean;
  /** Called for each script V8 reports, after the registry recorded it. */
  onScript: (script: ScriptRecord) => void;
  /** Called when the domain is turned off or forgotten, with the scripts and everything read from them gone. */
  onCleared: () => void;
  /** Reports an unexpected error from an inspector event: the debugger stops itself. */
  fail: (error: unknown) => void;
}

/** The inspector refused a command the breakpoints cannot work without. */
class DomainError extends Error {
  override readonly name = "DomainError";
}

/**
 * The inspector's `Debugger` domain: on while there is an entry to set, with the scripts V8 reports while it is on.
 * V8 reports every loaded script again each time it is turned on, so the records go with it.
 */
export class DebuggerDomain {
  readonly scripts = new ScriptRegistry();
  private unsubscribe: (() => void) | undefined;
  private isOn = false;

  constructor(private readonly dependencies: DomainDependencies) {}

  /** Listens to the inspector's `scriptParsed`, once however often it is called; none arrives while the domain is off. */
  listen(): void {
    this.stopListening();
    this.unsubscribe = this.dependencies.session.on("Debugger.scriptParsed", (params) => {
      try {
        const script = this.scripts.record(params);
        if (script !== undefined) {
          this.dependencies.onScript(script);
        }
      } catch (error) {
        this.dependencies.fail(error);
      }
    });
  }

  stopListening(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Turns the domain on; may throw. A stop inside the command leaves it off, which the caller checks. */
  turnOn(): void {
    if (this.isOn) {
      return;
    }

    const enabled = this.dependencies.session.post("Debugger.enable");
    if (!enabled.ok) {
      throw new DomainError("the inspector could not turn the Debugger domain on", { cause: enabled.error });
    }

    // Stopped by a scriptParsed handler during the command: the session is disconnected and the domain with it
    if (this.dependencies.isStopped()) {
      return;
    }

    this.isOn = true;
    this.dependencies.logger.log("debug", "Debugger domain on", { component: COMPONENT });
  }

  // When disabling fails the domain is still on and keeps its scripts, so the next list does not turn it on again
  turnOff(): void {
    if (!this.isOn) {
      return;
    }

    const disabled = this.dependencies.session.post("Debugger.disable");
    if (!disabled.ok) {
      this.dependencies.logger.log("warn", "the inspector could not turn the Debugger domain off", {
        component: COMPONENT,
        error: disabled.error,
      });
      return;
    }

    this.forget();
    this.dependencies.logger.log("debug", "Debugger domain off", { component: COMPONENT });
  }

  /** Forgets the scripts after `Debugger.disable` turned the domain off, from here or from outside. */
  forget(): void {
    this.scripts.clear();
    this.dependencies.onCleared();
    this.isOn = false;
  }
}
