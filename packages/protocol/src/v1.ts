// Version 1 pins `version: 1` rather than `typeof PROTOCOL_VERSION`, so a later version bump cannot retype it

// `Batch` is a frame around messages, not a message: it is left out so a batch cannot nest
/** Every protocol message: one JSON object with `version` and a `type` string. */
export type Message = Hello | Welcome | Breakpoints | BreakpointStatus | Snapshot;

/** The first message the SDK sends on every connection. */
export interface Hello {
  version: 1;
  type: "hello";
  instanceId: string;
  service?: string;
  labels: Record<string, string>;
  hostname: string;
  pid: number;
  sdk: { name: string; version: string };
  runtime: { name: string; version: string };
  /** The SDK modules this instance runs, such as `["debugger"]`. */
  modules: string[];
  /** The commit the instance runs, a lowercase hexadecimal hash of 7 to 64 characters; left out when unknown. */
  commit?: string;
}

/** The hub's reply to `hello`: it accepts the session. */
export interface Welcome {
  version: 1;
  type: "welcome";
  /** The modules of the `hello` the hub accepts for this session. */
  modules: string[];
}

/** A frame from the SDK to the hub that carries several messages in order. */
export interface Batch {
  version: 1;
  type: "batch";
  messages: Message[];
}

/** From the hub: the complete list of breakpoints the instance should have. */
export interface Breakpoints {
  version: 1;
  module: "debugger";
  type: "breakpoints";
  breakpoints: Breakpoint[];
}

/** One breakpoint in a `breakpoints` message. */
export interface Breakpoint {
  id: string;
  file: string;
  line: number;
  /** The milliseconds the breakpoint has left, an integer of at least 0. */
  expiresInMs: number;
  limits?: CaptureLimits;
}

/** How much of each value a snapshot keeps. */
export interface CaptureLimits {
  maxDepth?: number;
  maxItems?: number;
  maxStringLength?: number;
}

/** From the SDK: the state of one breakpoint. */
export interface BreakpointStatus {
  version: 1;
  module: "debugger";
  type: "breakpointStatus";
  breakpointId: string;
  status: "pending" | "active" | "rateLimited" | "expired" | "error";
  message?: string;
}

/** From the SDK: the state of the app at one hit of a breakpoint. */
export interface Snapshot {
  version: 1;
  module: "debugger";
  type: "snapshot";
  breakpointId: string;
  time: number;
  stack: StackFrame[];
  variables: Variable[];
  truncated?: boolean;
}

/** One frame of a snapshot's call stack, innermost first. */
export interface StackFrame {
  function: string;
  file: string;
  line: number;
  column: number;
}

/** A named value: a local variable or an object property. */
export interface Variable {
  name: string;
  value: Value;
}

/** One captured value, with its children inline. */
export type Value =
  | { type: "undefined" }
  | { type: "null" }
  | { type: "boolean"; value: boolean }
  | { type: "number"; value: number | "NaN" | "Infinity" | "-Infinity" | "-0" }
  | { type: "bigint"; value: string }
  | { type: "symbol"; value: string }
  | { type: "string"; value: string; length: number }
  | { type: "function"; name: string }
  | { type: "date"; value: string }
  | { type: "error"; className: string; message: string; stack?: string }
  | { type: "object"; className: string; properties?: Variable[]; truncated?: boolean }
  | { type: "array"; length: number; items?: Value[] }
  | { type: "set"; size: number; items?: Value[] }
  | { type: "map"; size: number; entries?: Array<{ key: Value; value: Value }> }
  | { type: "accessor" }
  | { type: "circular" }
  | { type: "redacted" }
  | { type: "unavailable"; reason: string };
