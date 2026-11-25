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
  close: (code: number) => void;
}

const fakeSocket = (): FakeSocket => {
  const closeCodes: number[] = [];
  return { closeCodes, close: (code) => closeCodes.push(code) };
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
    sessions.register(old.connection, INSTANCE);

    sessions.register(open().connection, INSTANCE);

    expect(old.socket.closeCodes).toEqual([1001]);
  });

  it("never replaces the session of an instanceId in another environment", () => {
    const { sessions, open } = setup();
    const production = open();
    sessions.register(production.connection, INSTANCE);

    sessions.register(open(keyOf({ environmentId: "staging" })).connection, INSTANCE);

    expect(production.socket.closeCodes).toEqual([]);
  });

  it("keeps the replacing session when the replaced one closes", async () => {
    const { sessions, open } = setup();
    const old = open();
    sessions.register(old.connection, INSTANCE);
    const replacing = open();
    sessions.register(replacing.connection, INSTANCE);
    old.raw.destroy();
    await old.connection.closed;

    sessions.register(open().connection, INSTANCE);

    expect(replacing.socket.closeCodes).toEqual([1001]);
  });

  it("refuses to register a connection that is closing", () => {
    const { sessions, open } = setup();
    const { connection } = open();
    sessions.close(connection, 1008);

    expect(sessions.register(connection, INSTANCE)).toBe(false);
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
});
