// The pure part of the benchmark: reads what the containers report, sums three runs up as a median with its spread and
// writes the table of docs/api/sdk/overview.md#overhead. No I/O, so it is tested without Docker.

/** One run of one mode, as the benchmark measured it. */
export interface RunResult {
  /** Requests per second in the closed-loop phase: the most the app serves. */
  readonly maxRequestsPerSecond: number;
  /** Latency in the fixed-rate phase, from the time each request was due. */
  readonly p50Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  /** The app's CPU time per second of the fixed-rate phase. */
  readonly cpuMsPerSecond: number;
  /** The app's peak resident memory over the whole run. */
  readonly rssPeakMib: number;
  /** Snapshots the hub received per second of the fixed-rate phase. */
  readonly snapshotsPerSecond: number;
}

/** The median of the runs of one metric and the range they span. */
export interface Spread {
  readonly median: number;
  readonly min: number;
  readonly max: number;
}

/** The runs of one mode, under the label of its table row. */
export interface ModeResults {
  readonly label: string;
  readonly runs: readonly RunResult[];
}

const KIB_PER_MIB = 1024;
const USAGE_USEC = /^usage_usec (\d+)$/m;
const VM_HWM_KIB = /^VmHWM:\s+(\d+) kB$/m;

/** The CPU time, in microseconds, of a cgroup v2 `cpu.stat` file. */
export const parseCpuUsageUsec = (cpuStat: string): number => {
  const match = USAGE_USEC.exec(cpuStat);
  if (match?.[1] === undefined) {
    throw new Error(`cpu.stat holds no usage_usec line: ${cpuStat}`);
  }

  return Number(match[1]);
};

/** The peak resident memory, in MiB, of a `/proc/<pid>/status` file (its `VmHWM`). */
export const parseRssPeakMib = (status: string): number => {
  const match = VM_HWM_KIB.exec(status);
  if (match?.[1] === undefined) {
    throw new Error("the process status holds no VmHWM line");
  }

  return Number(match[1]) / KIB_PER_MIB;
};

/** The median of `values`, with their minimum and maximum; for an even count, the mean of the middle two. */
export const summarize = (values: readonly number[]): Spread => {
  if (values.length === 0) {
    throw new Error("no values to summarize");
  }

  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[middle] : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  return { median: median ?? 0, min: sorted[0] ?? 0, max: sorted.at(-1) ?? 0 };
};

const formatNumber = (value: number, digits: number): string =>
  value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** `median (min–max)`, each with `digits` decimals. */
export const formatSpread = (spread: Spread, digits: number): string =>
  `${formatNumber(spread.median, digits)} (${formatNumber(spread.min, digits)}–${formatNumber(spread.max, digits)})`;

type Metric = keyof RunResult;

interface Column {
  readonly title: string;
  readonly metric: Metric;
  readonly digits: number;
}

const COLUMNS: readonly Column[] = [
  { title: "Max req/s", metric: "maxRequestsPerSecond", digits: 0 },
  { title: "p50 ms", metric: "p50Ms", digits: 2 },
  { title: "p99 ms", metric: "p99Ms", digits: 2 },
  { title: "Max ms", metric: "maxMs", digits: 1 },
  { title: "CPU ms/s", metric: "cpuMsPerSecond", digits: 0 },
  { title: "RSS MiB", metric: "rssPeakMib", digits: 0 },
  { title: "Snapshots/s", metric: "snapshotsPerSecond", digits: 1 },
];

/** A Markdown table: one row per mode, each cell the median of its runs with their range. */
export const formatTable = (modes: readonly ModeResults[]): string => {
  const header = `| Mode | ${COLUMNS.map((column) => column.title).join(" | ")} |`;
  const divider = `| --- | ${COLUMNS.map(() => "---").join(" | ")} |`;
  const rows = modes.map((mode) => {
    const cells = COLUMNS.map(({ metric, digits }) =>
      formatSpread(summarize(mode.runs.map((run) => run[metric])), digits),
    );
    return `| ${mode.label} | ${cells.join(" | ")} |`;
  });
  return [header, divider, ...rows].join("\n");
};

/** What the fake hub printed during one phase of a run, one JSON line per message. */
export interface HubEvents {
  readonly snapshots: number;
  readonly rateLimited: number;
  readonly hasExpired: boolean;
  readonly hasDisconnected: boolean;
  /** Whether the SDK connected: it sends `hello` first. */
  readonly hasHello: boolean;
}

const parseLine = (line: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    // The hub's own lines, such as "listening on port 8787", are not JSON
    return undefined;
  }
};

/** Counts the snapshots and `rateLimited` statuses in `lines`, and whether a breakpoint expired or the app left. */
export const countHubEvents = (lines: readonly string[]): HubEvents => {
  const messages = lines.map((line) => parseLine(line));
  const statuses = messages.filter((message) => message?.type === "breakpointStatus").map((message) => message?.status);
  return {
    snapshots: messages.filter((message) => message?.type === "snapshot").length,
    rateLimited: statuses.filter((status) => status === "rateLimited").length,
    hasExpired: statuses.includes("expired"),
    hasDisconnected: lines.includes("disconnected"),
    hasHello: messages.some((message) => message?.type === "hello"),
  };
};

/** Whether `lines` hold an `active` status of `breakpointId`. */
export const isActive = (lines: readonly string[], breakpointId: string): boolean =>
  lines.some((line) => {
    const message = parseLine(line);
    return message?.type === "breakpointStatus" && message.breakpointId === breakpointId && message.status === "active";
  });

/**
 * `metric` of each run of `mode` minus that of the run of `baseline` in the same round, summed up. Runs of one round
 * share the host's state, so a difference within a round is steadier than one between medians of different rounds.
 */
export const differByRound = (mode: ModeResults, baseline: ModeResults, metric: keyof RunResult): Spread =>
  summarize(
    mode.runs.flatMap((run, round) => {
      const base = baseline.runs[round];
      return base === undefined ? [] : [run[metric] - base[metric]];
    }),
  );
