import { assertType, describe, expectTypeOf, it } from "vitest";

import {
  CLOSE_CODES,
  PROTOCOL_VERSION,
  type Batch,
  type Breakpoint,
  type BreakpointStatus,
  type Breakpoints,
  type CaptureLimits,
  type Connector,
  type ConnectorStatus,
  type Hello,
  type Message,
  type Snapshot,
  type Value,
  type Welcome,
} from "../index.js";

type Handler<T> = (value: T) => void;

// Verbatim copy of the Usage example in docs/api/protocol.md
class MemoryConnector implements Connector {
  readonly sent: Message[] = [];
  private readonly messageHandlers = new Set<Handler<Message>>();
  private readonly statusHandlers = new Set<Handler<ConnectorStatus>>();
  private status: ConnectorStatus = "disconnected";
  private closing: Promise<void> | undefined;

  connect(): void {
    if (this.status === "disconnected") {
      this.report("connecting");
      this.report("connected");
    }
  }

  send(message: Message): void {
    if (this.status !== "closed") {
      this.sent.push(message);
    }
  }

  onMessage(handler: Handler<Message>): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStatus(handler: Handler<ConnectorStatus>): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  receive(message: Message): void {
    queueMicrotask(() => {
      emit(this.messageHandlers, message);
    });
  }

  close(): Promise<void> {
    this.closing ??= new Promise((resolve) => {
      queueMicrotask(() => {
        this.status = "closed";
        emit(this.statusHandlers, "closed");
        this.messageHandlers.clear();
        this.statusHandlers.clear();
        resolve();
      });
    });
    return this.closing;
  }

  private report(status: ConnectorStatus): void {
    this.status = status;
    queueMicrotask(() => {
      emit(this.statusHandlers, status);
    });
  }
}

const emit = <T>(handlers: Set<Handler<T>>, value: T): void => {
  for (const handler of [...handlers]) {
    try {
      handler(value);
    } catch {
      // a failing handler must not stop the others
    }
  }
};

describe("constants", () => {
  it("types the protocol version as the literal 1", () => {
    expectTypeOf<typeof PROTOCOL_VERSION>().toEqualTypeOf<1>();
  });

  it("types the close codes as readonly literals", () => {
    expectTypeOf<typeof CLOSE_CODES>().toEqualTypeOf<{
      readonly protocolError: 4400;
      readonly incompatibleVersion: 4426;
    }>();
  });
});

describe("messages", () => {
  it("accepts the message examples of the API doc", () => {
    assertType<Hello>({
      version: PROTOCOL_VERSION,
      type: "hello",
      instanceId: "i-1",
      service: "checkout",
      labels: { region: "eu" },
      hostname: "checkout-7d9f",
      pid: 1,
      sdk: { name: "@micafox/sdk", version: "0.1.0" },
      runtime: { name: "node", version: "22.0.0" },
      modules: ["debugger"],
      commit: "3f9c2e1a7b6d4c0e9f8a1b2c3d4e5f6a7b8c9d0e",
    });
    assertType<Welcome>({ version: PROTOCOL_VERSION, type: "welcome", modules: ["debugger"] });
    assertType<Breakpoints>({
      version: PROTOCOL_VERSION,
      module: "debugger",
      type: "breakpoints",
      breakpoints: [
        { id: "bp-1", file: "src/orders/checkout.ts", line: 42, expiresInMs: 3_600_000, limits: { maxDepth: 2 } },
      ],
    });
    assertType<BreakpointStatus>({
      version: PROTOCOL_VERSION,
      module: "debugger",
      type: "breakpointStatus",
      breakpointId: "bp-1",
      status: "error",
      message: "no code at or after line 42",
    });
    assertType<Snapshot>({
      version: PROTOCOL_VERSION,
      module: "debugger",
      type: "snapshot",
      breakpointId: "bp-1",
      time: 0,
      stack: [{ function: "checkout", file: "src/orders/checkout.ts", line: 42, column: 1 }],
      variables: [{ name: "total", value: { type: "number", value: 10 } }],
      truncated: true,
    });
    assertType<CaptureLimits>({ maxDepth: 5, maxItems: 50, maxStringLength: 100 });
  });

  it("limits messages to the five documented types", () => {
    expectTypeOf<Message["type"]>().toEqualTypeOf<
      "hello" | "welcome" | "breakpoints" | "breakpointStatus" | "snapshot"
    >();
  });

  it("ties every message and batch to the current protocol version", () => {
    expectTypeOf<Message["version"]>().toEqualTypeOf<typeof PROTOCOL_VERSION>();
    expectTypeOf<Batch["version"]>().toEqualTypeOf<typeof PROTOCOL_VERSION>();
  });

  it("rejects a message without a required field", () => {
    // @ts-expect-error labels is required
    assertType<Hello>({ version: PROTOCOL_VERSION, type: "hello", instanceId: "i-1", hostname: "h", pid: 1 });
    // @ts-expect-error line is required
    assertType<Breakpoint>({ id: "bp-1", file: "src/orders/checkout.ts", expiresInMs: 0 });
  });

  it("requires the module of every module message", () => {
    // @ts-expect-error module is required on breakpoints
    assertType<Breakpoints>({ version: PROTOCOL_VERSION, type: "breakpoints", breakpoints: [] });
    // @ts-expect-error module is required on breakpointStatus
    assertType<BreakpointStatus>({
      version: PROTOCOL_VERSION,
      type: "breakpointStatus",
      breakpointId: "b",
      status: "active",
    });
    // @ts-expect-error module is required on snapshot
    assertType<Snapshot>({
      version: PROTOCOL_VERSION,
      type: "snapshot",
      breakpointId: "b",
      time: 0,
      stack: [],
      variables: [],
    });
    expectTypeOf<Breakpoints["module"]>().toEqualTypeOf<"debugger">();
    expectTypeOf<BreakpointStatus["module"]>().toEqualTypeOf<"debugger">();
    expectTypeOf<Snapshot["module"]>().toEqualTypeOf<"debugger">();
  });

  it("leaves the module off the session frames", () => {
    expectTypeOf<Hello>().not.toHaveProperty("module");
    expectTypeOf<Welcome>().not.toHaveProperty("module");
    expectTypeOf<Batch>().not.toHaveProperty("module");
  });

  it("requires the modules of a hello and a welcome and leaves the commit optional", () => {
    expectTypeOf<Hello["modules"]>().toEqualTypeOf<string[]>();
    expectTypeOf<Welcome["modules"]>().toEqualTypeOf<string[]>();
    expectTypeOf<Hello["commit"]>().toEqualTypeOf<string | undefined>();
    // @ts-expect-error modules is required on welcome
    assertType<Welcome>({ version: PROTOCOL_VERSION, type: "welcome" });
    // @ts-expect-error modules is required on hello
    assertType<Hello>({
      version: PROTOCOL_VERSION,
      type: "hello",
      instanceId: "i",
      labels: {},
      hostname: "h",
      pid: 1,
      sdk: { name: "s", version: "1" },
      runtime: { name: "node", version: "22" },
    });
  });

  it("requires the time a breakpoint has left", () => {
    expectTypeOf<Breakpoint["expiresInMs"]>().toEqualTypeOf<number>();
  });

  it("rejects a message with a wrong version or type literal", () => {
    // @ts-expect-error version 2 is not the protocol version
    assertType<Welcome>({ version: 2, type: "welcome", modules: [] });
    // @ts-expect-error "welcom" is not a message type
    assertType<Welcome>({ version: PROTOCOL_VERSION, type: "welcom", modules: [] });
  });

  it("lists every breakpoint state, expired included", () => {
    expectTypeOf<BreakpointStatus["status"]>().toEqualTypeOf<
      "pending" | "active" | "rateLimited" | "expired" | "error"
    >();
  });

  it("rejects a status outside the breakpoint states", () => {
    // @ts-expect-error "paused" is not a breakpoint state
    assertType<BreakpointStatus["status"]>("paused");
  });

  it("keeps batches out of messages and out of other batches", () => {
    // @ts-expect-error a batch is a frame, not a message
    assertType<Message>({ version: PROTOCOL_VERSION, type: "batch", messages: [] });
    // @ts-expect-error batches do not nest
    assertType<Batch>({ version: PROTOCOL_VERSION, type: "batch", messages: [{ version: 1, type: "batch" }] });
  });
});

describe("values", () => {
  it("accepts every documented kind of value", () => {
    assertType<Value[]>([
      { type: "undefined" },
      { type: "null" },
      { type: "boolean", value: true },
      { type: "number", value: "-0" },
      { type: "bigint", value: "1" },
      { type: "symbol", value: "Symbol(a)" },
      { type: "string", value: "a", length: 1 },
      { type: "function", name: "f" },
      { type: "date", value: "2026-01-01T00:00:00.000Z" },
      { type: "error", className: "Error", message: "boom", stack: "at f" },
      { type: "object", className: "Order", properties: [{ name: "id", value: { type: "null" } }], truncated: true },
      { type: "array", length: 1, items: [{ type: "null" }] },
      { type: "set", size: 1, items: [{ type: "null" }] },
      { type: "map", size: 1, entries: [{ key: { type: "null" }, value: { type: "null" } }] },
      { type: "accessor" },
      { type: "circular" },
      { type: "redacted" },
      { type: "unavailable", reason: "maxDepth" },
    ]);
  });

  it("limits values to the eighteen documented kinds", () => {
    expectTypeOf<Value["type"]>().toEqualTypeOf<
      | "undefined"
      | "null"
      | "boolean"
      | "number"
      | "bigint"
      | "symbol"
      | "string"
      | "function"
      | "date"
      | "error"
      | "object"
      | "array"
      | "set"
      | "map"
      | "accessor"
      | "circular"
      | "redacted"
      | "unavailable"
    >();
  });

  it("rejects a string value without its full length", () => {
    // @ts-expect-error length is required on a string value
    assertType<Value>({ type: "string", value: "a" });
  });

  it("rejects an unknown kind of value", () => {
    // @ts-expect-error "regexp" is not a value type
    assertType<Value>({ type: "regexp" });
  });
});

describe("Connector", () => {
  it("has exactly the documented methods and statuses", () => {
    expectTypeOf<Connector>().toEqualTypeOf<{
      connect(): void;
      send(message: Message): void;
      onMessage(handler: (message: Message) => void): () => void;
      onStatus(handler: (status: ConnectorStatus) => void): () => void;
      close(): Promise<void>;
    }>();
    expectTypeOf<ConnectorStatus>().toEqualTypeOf<"connecting" | "connected" | "disconnected" | "closed">();
  });

  it("is implemented by the MemoryConnector of the API doc", () => {
    expectTypeOf<MemoryConnector>().toExtend<Connector>();
  });
});
