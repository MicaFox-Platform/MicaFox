import type { EventBus } from "./bus.js";
import { EventStream } from "./stream.js";
import type { StreamSink } from "./stream.js";
import type { Timers } from "../observability/index.js";

// A comment this often keeps proxies from closing a stream that is quiet
const KEEPALIVE_MS = 25_000;

/** A user has at most this many open streams, one per browser tab; one more ends their oldest. */
export const MAX_STREAMS_PER_USER = 10;

/** What the registry gives back: the ways to feed a stream and to end it. */
export interface OpenStream {
  onDrain: () => void;
  end: () => void;
}

/** The open events streams, found by organization to pass events on and by user to end them. */
export interface Streams {
  /** Opens a stream of `userId` for events of `orgIds`; it removes itself from here when it ends. */
  open: (params: { userId: string; orgIds: ReadonlySet<string>; sink: StreamSink }) => OpenStream;
  /** Ends every stream of `userId`, as when they log out everywhere. */
  endUser: (userId: string) => void;
  /** Ends every stream, as the stop does before it drains the requests. */
  endAll: () => void;
}

// A stream with the `end` that also removes it from the registry
interface Entry {
  stream: EventStream;
  end: () => void;
}

const addTo = <Key>(index: Map<Key, Set<Entry>>, key: Key, entry: Entry): void => {
  const entries = index.get(key) ?? new Set<Entry>();
  entries.add(entry);
  index.set(key, entries);
};

const removeFrom = <Key>(index: Map<Key, Set<Entry>>, key: Key, entry: Entry): void => {
  const entries = index.get(key);
  entries?.delete(entry);
  if (entries?.size === 0) {
    index.delete(key);
  }
};

// Ends the oldest of a user's streams when they have the most they may, so one more fits
const makeRoomFor = (opened: ReadonlySet<Entry> | undefined): void => {
  if (opened !== undefined && opened.size >= MAX_STREAMS_PER_USER) {
    // A set keeps the order entries were added in, so the first is the oldest
    [...opened][0]?.end();
  }
};

// Sends the stream a comment every 25 s; the function it returns stops that
const startKeepAlive = (stream: EventStream, timers: Timers): (() => void) => {
  let timer: NodeJS.Timeout | undefined;
  const schedule = (): void => {
    timer = timers.setTimeout(() => {
      stream.keepAlive();
      schedule();
    }, KEEPALIVE_MS);
  };
  schedule();
  return () => {
    if (timer !== undefined) {
      timers.clearTimeout(timer);
    }
  };
};

/**
 * Creates the streams over `bus`: each event goes to the streams of its organization only, O(streams of that
 * organization). A user keeps at most {@link MAX_STREAMS_PER_USER}, so the streams are bounded by the users.
 */
export const createStreams = (bus: EventBus, timers: Timers): Streams => {
  const byOrg = new Map<string, Set<Entry>>();
  const byUser = new Map<string, Set<Entry>>();

  bus.subscribe((event) => {
    for (const { stream } of byOrg.get(event.orgId) ?? []) {
      stream.offer(event);
    }
  });

  const open: Streams["open"] = ({ userId, orgIds, sink }) => {
    makeRoomFor(byUser.get(userId));
    const stream = new EventStream({ userId, orgIds, sink });
    const stopKeepAlive = startKeepAlive(stream, timers);
    const entry: Entry = {
      stream,
      end: () => {
        stopKeepAlive();
        for (const orgId of orgIds) {
          removeFrom(byOrg, orgId, entry);
        }
        removeFrom(byUser, userId, entry);
        stream.end();
      },
    };
    for (const orgId of orgIds) {
      addTo(byOrg, orgId, entry);
    }
    addTo(byUser, userId, entry);
    return {
      onDrain: () => {
        stream.onDrain();
      },
      end: entry.end,
    };
  };

  return {
    open,
    endUser: (userId) => {
      // Ending a stream removes it from the set, so the loop walks a copy
      for (const entry of [...(byUser.get(userId) ?? [])]) {
        entry.end();
      }
    },
    endAll: () => {
      for (const entry of [...byUser.values()].flatMap((entries) => [...entries])) {
        entry.end();
      }
    },
  };
};
