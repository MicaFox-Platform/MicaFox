import type { WebSocket } from "@fastify/websocket";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";

import { createManualClock } from "../../../../test/server/manual-clock.js";
import type { KeyScope } from "../../access/index.js";
import { SdkSessions } from "../sessions.js";
import type { Connection } from "../sessions.js";

const ORG_A = "0b6f3a52-6a3e-4e55-9d0c-6f1c1d2b8a01";
const ORG_B = "4d1e9c07-21b4-4f0a-8c3e-0a9f7e5d6b02";
const INSTANCE = "8f14e45f-ceea-467f-a0e6-3b5c2a1d9e7b";
const silent = pino({ enabled: false });

const keyOf = (overrides: Partial<KeyScope> = {}): KeyScope => ({
  keyId: "key-1",
  prefix: "mfx_pk_abcde",
  orgId: ORG_A,
  projectId: "project-1",
  environmentId: "production",
  ...overrides,
});

// The part of a WebSocket the sessions use: closing with a code
interface FakeSocket {
  closeCodes: number[];
  sent: string[];
  readyState: number;
  close: (code: number) => void;
  send: (frame: string) => void;
}

const fakeSocket = (): FakeSocket => {
  const closeCodes: number[] = [];
  const sent: string[] = [];
  return {
    closeCodes,
    sent,
    readyState: 1,
    close: (code) => closeCodes.push(code),
    send: (frame) => sent.push(frame),
  };
};

// The sessions only ever call `close` on a socket; the fake has that alone
const asWebSocket = (socket: FakeSocket): WebSocket => socket as unknown as WebSocket;

const setup = () => {
  const manual = createManualClock();
  const sessions = new SdkSessions({ timers: manual.clock, now: manual.clock.now });
  const open = (key: KeyScope = keyOf()): { connection: Connection; socket: FakeSocket; raw: PassThrough } => {
    const raw = new PassThrough();
    const connection = sessions.reserve(key, raw, silent);
    const socket = fakeSocket();
    sessions.attach(connection, asWebSocket(socket));
    return { connection, socket, raw };
  };
  return { manual, sessions, open };
};

describe("SdkSessions", () => {
  it("counts a connection from its key check until its socket closes", async () => {
    const { sessions, open } = setup();
    const first = open();
    open(keyOf({ keyId: "key-2" }));
    const counted = [sessions.size, sessions.countOfKey("key-1")];

    first.raw.destroy();
    await first.connection.closed;

    expect([...counted, sessions.size, sessions.countOfKey("key-1")]).toEqual([2, 1, 1, 0]);
  });

  it("forgets a connection whose client hung up before its key check ended", async () => {
    const { sessions } = setup();
    const raw = new PassThrough();
    raw.destroy();
    await once(raw, "close");

    await sessions.reserve(keyOf(), raw, silent).closed;

    expect(sessions.size).toBe(0);
  });

  it("closes the session of the same instance in the same environment with 1001", () => {
    const { sessions, open } = setup();
    const old = open();
    sessions.register(old.connection, { instanceId: INSTANCE, modules: [], version: 1 });

    sessions.register(open().connection, { instanceId: INSTANCE, modules: [], version: 1 });

    expect(old.socket.closeCodes).toEqual([1001]);
  });

  it("never replaces the session of an instanceId in another environment", () => {
    const { sessions, open } = setup();
    const production = open();
    sessions.register(production.connection, { instanceId: INSTANCE, modules: [], version: 1 });

    sessions.register(open(keyOf({ environmentId: "staging" })).connection, {
      instanceId: INSTANCE,
      modules: [],
      version: 1,
    });

    expect(production.socket.closeCodes).toEqual([]);
  });

  it("keeps the replacing session when the replaced one closes", async () => {
    const { sessions, open } = setup();
    const old = open();
    sessions.register(old.connection, { instanceId: INSTANCE, modules: [], version: 1 });
    const replacing = open();
    sessions.register(replacing.connection, { instanceId: INSTANCE, modules: [], version: 1 });
    old.raw.destroy();
    await old.connection.closed;

    sessions.register(open().connection, { instanceId: INSTANCE, modules: [], version: 1 });

    expect(replacing.socket.closeCodes).toEqual([1001]);
  });

  it("refuses to register a connection that is closing", () => {
    const { sessions, open } = setup();
    const { connection } = open();
    sessions.close(connection, 1008);

    expect(sessions.register(connection, { instanceId: INSTANCE, modules: [], version: 1 })).toBe(false);
  });

  it("closes every connection of a revoked key with its code, and no other", () => {
    const { sessions, open } = setup();
    const revoked = [open(), open()];
    const other = open(keyOf({ keyId: "key-2" }));

    sessions.closeKey("key-1", 1008);

    expect([...revoked, other].map(({ socket }) => socket.closeCodes)).toEqual([[1008], [1008], []]);
  });

  it("closes every connection of an organization, and no other", () => {
    const { sessions, open } = setup();
    const ofA = open();
    const ofB = open(keyOf({ keyId: "key-2", orgId: ORG_B }));

    sessions.closeOrg(ORG_A, 1001);

    expect([ofA.socket.closeCodes, ofB.socket.closeCodes]).toEqual([[1001], []]);
  });

  it("closes a connection reserved before its upgrade once it gets its socket", () => {
    const { sessions } = setup();
    const connection = sessions.reserve(keyOf(), new PassThrough(), silent);
    sessions.closeKey("key-1", 1008);
    const socket = fakeSocket();

    sessions.attach(connection, asWebSocket(socket));

    expect(socket.closeCodes).toEqual([1008]);
  });

  it("cuts off a peer that does not answer a close within 2 s", () => {
    const { sessions, open, manual } = setup();
    const { connection, raw } = open();
    sessions.close(connection, 1001);
    manual.advance(1999);
    const destroyedEarly = raw.destroyed;

    manual.advance(1);

    expect([destroyedEarly, raw.destroyed]).toEqual([false, true]);
  });

  it("settles closeAll once every connection has closed", async () => {
    const { sessions, open, manual } = setup();
    open();
    open(keyOf({ keyId: "key-2" }));
    const closing = sessions.closeAll(1001);

    manual.advance(2000);
    await closing;

    expect(sessions.size).toBe(0);
  });

  it("lists the registered sessions of an environment that agreed on a module", () => {
    const { sessions, open } = setup();
    const agreed = open();
    const other = open();
    const elsewhere = open(keyOf({ environmentId: "staging" }));
    const unregistered = open();
    sessions.register(agreed.connection, { instanceId: "a", modules: ["debugger", "metrics"], version: 1 });
    sessions.register(other.connection, { instanceId: "b", modules: ["metrics"], version: 1 });
    sessions.register(elsewhere.connection, { instanceId: "c", modules: ["debugger"], version: 1 });

    expect([
      sessions.inEnvironment("production", "debugger"),
      sessions.inEnvironment("production", "metrics"),
      unregistered.connection.session,
    ]).toEqual([[agreed.connection], [agreed.connection, other.connection], undefined]);
  });

  it("gives a registered session what a feature sees of the instance", () => {
    const { sessions, open } = setup();
    const { connection } = open();

    sessions.register(connection, { instanceId: INSTANCE, modules: ["debugger"], version: 1 });

    expect(connection.session).toEqual({
      orgId: ORG_A,
      projectId: "project-1",
      environmentId: "production",
      instanceId: INSTANCE,
    });
  });

  it("leaves the environment's list when the connection closes, and a closing session is not listed", async () => {
    const { sessions, open } = setup();
    const closing = open();
    const closed = open();
    sessions.register(closing.connection, { instanceId: "a", modules: ["debugger"], version: 1 });
    sessions.register(closed.connection, { instanceId: "b", modules: ["debugger"], version: 1 });
    sessions.close(closing.connection, 1001);
    closed.raw.destroy();
    await closed.connection.closed;

    expect(sessions.inEnvironment("production", "debugger")).toEqual([]);
  });

  it("sends a frame to an open session and to none that is closing or whose socket is not open", () => {
    const { sessions, open } = setup();
    const open1 = open();
    const closing = open();
    const notOpen = open();
    notOpen.socket.readyState = 2;
    sessions.close(closing.connection, 1001);

    const answers = [open1, closing, notOpen].map(({ connection }) => sessions.send(connection, "frame"));

    expect([answers, open1.socket.sent, closing.socket.sent, notOpen.socket.sent]).toEqual([
      [true, false, false],
      ["frame"],
      [],
      [],
    ]);
  });
});
