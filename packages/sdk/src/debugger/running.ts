import type { Message } from "@micafox/protocol";

import { Breakpoints } from "./breakpoints/index.js";
import type { ConnectorChoice } from "./connector-choice.js";
import { ConnectorLink } from "./connector-link.js";
import { InspectorSession, type InspectorBinding } from "./inspector-session.js";
import { Pauses } from "./pauses/index.js";
import { RateLimiter } from "./rate-limiter/index.js";
import type { RedactionRules } from "./redaction/index.js";
import type { SdkLogger } from "../logger/index.js";

/** What one `run()` started, so that `stop()` undoes exactly that. */
export interface Running {
  readonly connector: ConnectorChoice;
  readonly link: ConnectorLink;
  readonly session: InspectorSession;
  readonly breakpoints: Breakpoints;
  readonly pauses: Pauses;
}

/** What the parts of one run need from the debugger. */
export interface RunningOptions {
  choice: ConnectorChoice;
  redaction: RedactionRules;
  logger: SdkLogger;
  binding: InspectorBinding;
  /** The monotonic clock in milliseconds that the rate limits and the breakpoints' time left count on. */
  now: () => number;
  /** Reports an unexpected error from a part: the debugger stops itself. */
  fail: (error: unknown) => void;
}

/** Wires the parts of one `run()`: the connector link, the inspector session, the breakpoints and the pauses. */
export const createRunning = (options: RunningOptions): Running => {
  const { choice, redaction, logger, now, fail } = options;
  const link = new ConnectorLink(choice.connector, logger);
  const session = new InspectorSession(logger, options.binding);
  const limiter = new RateLimiter(now);
  const send = (message: Message): void => {
    link.send(message);
  };
  const breakpoints = new Breakpoints({
    session,
    logger,
    send,
    fail,
    onRemoved: (id) => {
      limiter.forget(id);
    },
    now,
  });
  const pauses = new Pauses({
    session,
    logger,
    breakpoints,
    limiter,
    isSecret: (name) => redaction.isSecret(name),
    send,
    fail,
  });
  return { connector: choice, link, session, breakpoints, pauses };
};
