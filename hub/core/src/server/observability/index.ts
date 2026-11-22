import pino from "pino";
import type { Logger } from "pino";
import pinoPretty from "pino-pretty";

import { createWarnCollapser } from "./collapse-warnings.js";
import type { WarnCollapser, Timers } from "./collapse-warnings.js";
import { redactSecrets } from "./redact.js";

export type { Timers } from "./collapse-warnings.js";

/** What `createLogger` needs: the settings that shape the log, and where it goes. */
export interface LoggerOptions {
  level: "debug" | "info" | "warn" | "error";
  format: "json" | "pretty";
  stream: NodeJS.WritableStream;
  timers: Timers;
}

/** The hub's logger and its collapsing `warn`. */
export interface HubLogger {
  log: Logger;
  warnCollapsed: WarnCollapser["warn"];
  /** Logs pending warning counts; call it once before the process ends. */
  flush: () => void;
}

/** Creates the pino logger: JSON lines, or pretty output, with secrets redacted at any depth. */
export const createLogger = (options: LoggerOptions): HubLogger => {
  // A closed pipe on stdout (EPIPE) must not crash the hub
  options.stream.on("error", () => undefined);
  // Pretty output is for development: piped through pino-pretty, its last lines before an exit may be lost
  const destination = options.format === "pretty" ? pinoPretty({ destination: options.stream }) : options.stream;
  const log = pino(
    {
      level: options.level,
      // pino runs `log` before the serializers, which skip Error instances, so errors are redacted once serialized.
      // A child logger's bindings pass neither: pino resets the bindings formatter for children. They hold ids such
      // as `orgId`, never secrets.
      formatters: {
        level: (label) => ({ level: label }),
        log: redactSecrets,
      },
      serializers: {
        // The serialized error has pino's own prototype; a plain copy lets the walk see its fields
        err: (error: Error) => redactSecrets({ ...pino.stdSerializers.err(error) }),
      },
    },
    destination,
  );
  const collapser = createWarnCollapser(log, options.timers);
  return { log, warnCollapsed: collapser.warn, flush: collapser.flush };
};
