// One route per group of value types, each building its values as locals and returning at a line to breakpoint: the
// line after the marker `// breakpoint on the next line: <group>`, which tests/ finds by its group. A snapshot there
// shows how the debugger captures every kind of value, within its limits. Nothing here is a model for real code.

import type { FastifyInstance } from "fastify";

// Values just large enough for their limits: V8 hands a string and an object's own properties to the debugger whole,
// within its 10 ms per pause, so larger ones only make a capture slower on a slow machine.
// A string of this size cannot be captured whole: a string is cut at 4096 UTF-16 code units at most
const HUGE_TEXT_LENGTH = 10_000;
// 24 properties of 4096 characters pass the 64 KiB of a snapshot with the limits at their caps, and 20 items
const HUGE_OBJECT_PROPERTIES = 24;
const HUGE_PROPERTY_LENGTH = 4096;
// More than the default 20 items of a container
const ABOVE_MAX_ITEMS = 25;
const DEFAULT_SECRET = "demo-values-secret";

class Order {
  constructor(
    readonly id: string,
    readonly quantity: number,
    readonly note?: string,
  ) {}
}

// Every local is passed here, so the breakpoint's line uses it and no lint rule calls it unused; the reply is only
// there to show the app answers while the breakpoint is set
const describeLocals = (group: string, ...locals: unknown[]): { group: string; locals: number } => ({
  group,
  locals: locals.length,
});

const countUp = (count: number): number[] => Array.from({ length: count }, (_, index) => index + 1);

// The secret the `secrets` route nests in its values; set by the environment, so a test can look for it in the output
const readSecret = (): string => process.env.VALUES_SECRET ?? DEFAULT_SECRET;

const onPrimitives = (): { group: string; locals: number } => {
  const text = "hello";
  const count = 42;
  const bigNumber = 12_345_678_901_234_567_890n;
  const isReady = true;
  const nothing = null;
  const missing = undefined;
  const tag = Symbol("tag");
  const notANumber = Number.NaN;
  const negativeZero = -0;
  // breakpoint on the next line: primitives
  return describeLocals("primitives", text, count, bigNumber, isReady, nothing, missing, tag, notANumber, negativeZero);
};

interface LinkedItem {
  name: string;
  next?: LinkedItem;
}

const onNesting = (): { group: string; locals: number } => {
  const deep = { level1: { level2: { level3: { level4: { level5: "bottom" } } } } };
  const shallow = { level1: { value: 1 } };
  const loop: LinkedItem = { name: "loop" };
  loop.next = loop;
  // breakpoint on the next line: nesting
  return describeLocals("nesting", deep, shallow, loop);
};

const onCollections = (): { group: string; locals: number } => {
  const smallList = [1, 2, 3];
  const bigList = countUp(ABOVE_MAX_ITEMS);
  const smallSet = new Set(["a", "b"]);
  const bigSet = new Set(countUp(ABOVE_MAX_ITEMS));
  const smallMap = new Map([["one", 1]]);
  const bigMap = new Map(countUp(ABOVE_MAX_ITEMS).map((number) => [`key${String(number)}`, number]));
  // breakpoint on the next line: collections
  return describeLocals("collections", smallList, bigList, smallSet, bigSet, smallMap, bigMap);
};

const onObjects = (): { group: string; locals: number } => {
  const order = new Order("o-17", 3, "gift");
  const createdAt = new Date("2026-11-12T10:30:45.678Z");
  const pattern = /ab+c/gi;
  const failure = new RangeError("out of stock");
  const buffer = Buffer.from("hello");
  const bytes = new Uint8Array([1, 2, 3]);
  const total = (price: number, quantity: number): number => price * quantity;
  const pending = new Promise<number>(() => undefined);
  // breakpoint on the next line: objects
  return describeLocals("objects", order, createdAt, pattern, failure, buffer, bytes, total, pending);
};

const onLarge = (): { group: string; locals: number } => {
  const hugeText = "x".repeat(HUGE_TEXT_LENGTH);
  const hugeObject = Object.fromEntries(
    countUp(HUGE_OBJECT_PROPERTIES).map((number) => [`part${String(number)}`, "y".repeat(HUGE_PROPERTY_LENGTH)]),
  );
  // breakpoint on the next line: large
  return describeLocals("large", hugeText, hugeObject);
};

const onSecrets = (): { group: string; locals: number } => {
  const login = { user: "ada", password: readSecret() };
  const settings = {
    theme: "dark",
    account: { owner: "ada", nested: { deeper: { cookie: readSecret() } } },
  };
  const accounts = [{ id: 1, token: readSecret() }, { id: 2 }];
  const headers = new Map([["authorization", readSecret()]]);
  // breakpoint on the next line: secrets
  return describeLocals("secrets", login, settings, accounts, headers);
};

/** Adds the `/values/<group>` routes: each answers with a summary and holds its values as locals to capture. */
export const registerValueRoutes = (server: FastifyInstance): void => {
  server.get("/values/primitives", onPrimitives);
  server.get("/values/nesting", onNesting);
  server.get("/values/collections", onCollections);
  server.get("/values/objects", onObjects);
  server.get("/values/large", onLarge);
  server.get("/values/secrets", onSecrets);
};
