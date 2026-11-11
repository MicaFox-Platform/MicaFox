import type { Connector, ConnectorStatus, Message } from "@micafox/protocol";
import { assertType, describe, expectTypeOf, it } from "vitest";

import { HubConnector, type HubConnectorOptions, type LogContext, type Logger, type LogLevel } from "../index.js";

type Write = (message: string, context: LogContext) => void;

// A stand-in for pino's methods, so the Usage example of docs/api/sdk/logger.md compiles without pino
type PinoMethod = (obj: object, msg: string) => void;
declare const log: Record<"debug" | "info" | "warn" | "error", PinoMethod>;

describe("logger types", () => {
  it("defines Logger as the four methods of docs/api/sdk/logger.md", () => {
    expectTypeOf<Logger>().toEqualTypeOf<{ debug: Write; info: Write; warn: Write; error: Write }>();
  });

  it("defines LogContext as in docs/api/sdk/logger.md", () => {
    expectTypeOf<LogContext>().toEqualTypeOf<{
      component: string;
      breakpointId?: string;
      error?: { name: string; message: string; code?: string; stack?: string };
      count?: number;
    }>();
  });

  it("defines LogLevel as the four line levels and silent", () => {
    expectTypeOf<LogLevel>().toEqualTypeOf<"debug" | "info" | "warn" | "error" | "silent">();
  });

  it("accepts console as a Logger", () => {
    assertType<Logger>(console);
  });

  it("accepts the pino adapter from the Usage example", () => {
    // The adapter in docs/api/sdk/logger.md#usage, with block bodies as the lint rules require
    assertType<Logger>({
      debug: (message, context) => {
        log.debug(context, message);
      },
      info: (message, context) => {
        log.info(context, message);
      },
      warn: (message, context) => {
        log.warn(context, message);
      },
      error: (message, context) => {
        log.error(context, message);
      },
    });
  });

  it("rejects a Logger without one of the four methods", () => {
    const write: Write = () => undefined;

    // @ts-expect-error error is required
    assertType<Logger>({ debug: write, info: write, warn: write });
  });

  it("rejects a LogContext without a component", () => {
    // @ts-expect-error component is required
    assertType<LogContext>({ breakpointId: "bp-1" });
  });

  it("rejects a level outside LogLevel", () => {
    // @ts-expect-error "verbose" is not a level
    assertType<LogLevel>("verbose");
  });
});

// The signature blocks of docs/api/sdk/connector.md; its examples are compiled from test/docs/connector-*.test-d.ts
describe("connector types", () => {
  it("defines HubConnectorOptions as in docs/api/sdk/connector.md", () => {
    expectTypeOf<HubConnectorOptions>().toEqualTypeOf<{
      url?: string;
      token?: string;
      service?: string;
      labels?: Record<string, string>;
      logger?: Logger;
      logLevel?: LogLevel;
      buffer?: { maxMessages?: number; maxBytes?: number };
      batch?: { maxMessages?: number; maxBytes?: number; flushIntervalMs?: number };
      rateLimit?: { bytesPerSecond?: number };
      reconnect?: { minDelayMs?: number; maxDelayMs?: number };
      closeTimeoutMs?: number;
    }>();
  });

  it("gives HubConnector the constructor of docs/api/sdk/connector.md", () => {
    expectTypeOf(HubConnector).constructorParameters.toEqualTypeOf<[options?: HubConnectorOptions | undefined]>();
  });

  it("gives HubConnector the methods of docs/api/sdk/connector.md", () => {
    expectTypeOf<keyof HubConnector>().toEqualTypeOf<"connect" | "send" | "onMessage" | "onStatus" | "close">();
    expectTypeOf<HubConnector["connect"]>().toEqualTypeOf<() => void>();
    expectTypeOf<HubConnector["send"]>().toEqualTypeOf<(message: Message) => void>();
    expectTypeOf<HubConnector["onMessage"]>().toEqualTypeOf<(handler: (message: Message) => void) => () => void>();
    expectTypeOf<HubConnector["onStatus"]>().toEqualTypeOf<
      (handler: (status: ConnectorStatus) => void) => () => void
    >();
    expectTypeOf<HubConnector["close"]>().toEqualTypeOf<() => Promise<void>>();
  });

  it("makes HubConnector a Connector", () => {
    expectTypeOf<HubConnector>().toExtend<Connector>();
  });
});
