import type { Message } from "@micafox/protocol";

import type { ProtocolModule, SdkSession } from "../../src/server/feature/index.js";

/** What a recording module saw of one message. */
export interface Received {
  session: SdkSession;
  message: Message;
}

/** An SDK module of a feature that keeps what it is handed, and answers `state` and `onMessage` as a test says. */
export interface RecordingModule extends ProtocolModule {
  received: Received[];
  /** The sessions `state` was asked for, in order. */
  stateAsked: SdkSession[];
  /** Settles once `count` messages have reached `onMessage`. */
  delivered: (count: number) => Promise<void>;
}

/** What a test makes the module do; each is called per `state` or `onMessage`. */
export interface RecordingBehavior {
  state?: (session: SdkSession) => Promise<readonly Message[]>;
  onMessage?: (session: SdkSession, message: Message) => Promise<void>;
}

/** A `breakpoints` message with the given ids, which is what a debugger's state is. */
export const breakpointsOf = (...ids: string[]): Message => ({
  version: 1,
  module: "debugger",
  type: "breakpoints",
  breakpoints: ids.map((id) => ({ id, file: "/app/a.js", line: 1, expiresInMs: 1000 })),
});

export const recordingModule = (module: string, behavior: RecordingBehavior = {}): RecordingModule => {
  const received: Received[] = [];
  const stateAsked: SdkSession[] = [];
  const waiting: Array<{ count: number; resolve: () => void }> = [];
  return {
    module,
    received,
    stateAsked,
    delivered: async (count) => {
      await new Promise<void>((resolve) => {
        if (received.length >= count) {
          resolve();
        } else {
          waiting.push({ count, resolve });
        }
      });
    },
    state: async (session) => {
      stateAsked.push(session);
      return await (behavior.state?.(session) ?? Promise.resolve([]));
    },
    onMessage: async (session, message) => {
      received.push({ session, message });
      for (const waiter of waiting.filter(({ count }) => count <= received.length)) {
        waiter.resolve();
      }
      await behavior.onMessage?.(session, message);
    },
  };
};
