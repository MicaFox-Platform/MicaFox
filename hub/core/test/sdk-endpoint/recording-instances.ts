import type { Instances, Tracked, TrackedSession } from "../../src/server/sdk-endpoint/index.js";

/** `Instances` that keep what they were given instead of writing it, for tests of what calls them. */
export interface RecordingInstances extends Instances {
  /** The sessions `track` was called with, in order. */
  tracked: TrackedSession[];
  /** What the next `track` answers. */
  result: Tracked;
  /** Makes `track` reject with it, as `Instances` promise never to. */
  failure: Error | undefined;
  /** `idle` settles only once this does. */
  idleHold: Promise<void>;
  /** How often each of the other calls ran. */
  calls: { writeLastSeen: number; deleteStale: number; idle: number };
}

export const createRecordingInstances = (): RecordingInstances => {
  const recording: RecordingInstances = {
    tracked: [],
    result: { cut: 0, replaced: 0 },
    failure: undefined,
    idleHold: Promise.resolve(),
    calls: { writeLastSeen: 0, deleteStale: 0, idle: 0 },
    track: async (session) => {
      recording.tracked.push(session);
      if (recording.failure !== undefined) {
        throw recording.failure;
      }
      return await Promise.resolve(recording.result);
    },
    writeLastSeen: async () => {
      recording.calls.writeLastSeen += 1;
      await Promise.resolve();
    },
    deleteStale: async () => {
      recording.calls.deleteStale += 1;
      await Promise.resolve();
    },
    addRoutes: () => undefined,
    idle: async () => {
      recording.calls.idle += 1;
      await recording.idleHold;
    },
  };
  return recording;
};
