/** How a run ended: done, failed, left to another replica that held the lock, or cut at its time limit. */
export type RunResult = "ok" | "failed" | "skipped" | "timeout";

/** How many runs of a job ended with a result since the hub started. */
export interface RunCount {
  job: string;
  result: RunResult;
  count: number;
}

/** The runs of each job by result: what the jobs metric reports. */
export interface RunCounts {
  add: (job: string, result: RunResult) => void;
  list: () => RunCount[];
}

/** Counts runs in memory; at most one entry per job and result, so it stays as small as the list of jobs. */
export const createRunCounts = (): RunCounts => {
  const counts = new Map<string, RunCount>();
  return {
    add: (job, result) => {
      const key = `${job}\0${result}`;
      const entry = counts.get(key);
      counts.set(key, { job, result, count: (entry?.count ?? 0) + 1 });
    },
    list: () => [...counts.values()],
  };
};
