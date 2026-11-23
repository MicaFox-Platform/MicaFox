import { sql } from "kysely";
import type { Kysely } from "kysely";

import type { HubTables } from "./scope.js";
import type { Timers } from "../observability/index.js";

/** The attributes of the role the hub runs as. */
export interface RoleProbe {
  role: string;
  isSuperuser: boolean;
  bypassesRls: boolean;
}

/** The app role could read every organization's rows, so the hub does not start. */
export class DatabaseRoleError extends Error {
  constructor(role: string, attribute: "SUPERUSER" | "BYPASSRLS") {
    super(
      `The database role ${role} has ${attribute}, which bypasses row-level security: connect as a role without it`,
    );
    this.name = "DatabaseRoleError";
  }
}

/** The probe got no answer in time; the database counts as unreachable. */
export class ProbeTimeoutError extends Error {
  constructor() {
    super("The database did not answer in time");
    this.name = "ProbeTimeoutError";
  }
}

/** What waiting for the database needs: how to probe it, time, and the collapsing warning. */
export interface ConnectOptions {
  probe: () => Promise<RoleProbe>;
  timers: Timers;
  warnCollapsed: (key: string, fields: Record<string, unknown>, message: string) => void;
}

const FIRST_DELAY_MS = 250;
const MAX_DELAY_MS = 10_000;
// connectionTimeoutMillis covers only connecting: a server that accepts and never answers needs its own limit
const PROBE_TIMEOUT_MS = 5000;

// Errors of the network, not of Postgres, that a restart or a later DNS answer may end
const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
]);
// Postgres is starting, stopping or full: 57P03 cannot_connect_now, 57P01 admin_shutdown, 53300 too_many_connections
const PASSING_STATES = new Set(["57P03", "57P01", "53300"]);
// pg ends a connection the server dropped, and a wait for a pooled connection, with errors that have no code
const PG_CONNECTION_MESSAGES = /^(Connection terminated|timeout exceeded when trying to connect)/;

/** The wait before retry `attempt` (0 first): doubling from 250 ms up to 10 s. */
export const retryDelayMs = (attempt: number): number => Math.min(FIRST_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);

/** Whether an error says the database cannot be reached yet, rather than that it refused the hub. */
export const isUnreachable = (error: unknown): boolean => {
  if (error instanceof ProbeTimeoutError) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  if (code === undefined) {
    return PG_CONNECTION_MESSAGES.test(error.message);
  }
  return NETWORK_CODES.has(code) || code.startsWith("08") || PASSING_STATES.has(code);
};

interface WaitContext {
  timers: Timers;
  signal: AbortSignal;
}

// A wait that a stop ends at once; `cancel` drops its timer and listener once it is no longer needed
interface Wait {
  done: Promise<void>;
  cancel: () => void;
}

const abortError = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new Error("The start was aborted", { cause: signal.reason });

const startWait = (delayMs: number, context: WaitContext): Wait => {
  const { timers, signal } = context;
  let cancel = (): void => undefined;
  const done = new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      timers.clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = timers.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
    cancel = () => {
      timers.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
  });
  return { done, cancel };
};

const probeWithin = async (probe: Promise<RoleProbe>, context: WaitContext): Promise<RoleProbe> => {
  const limit = startWait(PROBE_TIMEOUT_MS, context);
  // A probe that loses the race must not surface as an unhandled rejection
  probe.catch(() => undefined);
  try {
    return await Promise.race([
      probe,
      limit.done.then(() => {
        throw new ProbeTimeoutError();
      }),
    ]);
  } finally {
    limit.cancel();
  }
};

const checkRole = (probe: RoleProbe): void => {
  if (probe.isSuperuser) {
    throw new DatabaseRoleError(probe.role, "SUPERUSER");
  }
  if (probe.bypassesRls) {
    throw new DatabaseRoleError(probe.role, "BYPASSRLS");
  }
};

/**
 * The readiness step of the database: probes it until it answers, retrying with backoff while it is unreachable,
 * then fails when the role bypasses row-level security. Any other error fails the start at once.
 */
export const connectDatabase = async (options: ConnectOptions, signal: AbortSignal): Promise<void> => {
  const context: WaitContext = { timers: options.timers, signal };
  for (let attempt = 0; ; attempt += 1) {
    signal.throwIfAborted();
    let probe: RoleProbe;
    try {
      probe = await probeWithin(options.probe(), context);
    } catch (error) {
      if (signal.aborted || !isUnreachable(error)) {
        throw error;
      }
      options.warnCollapsed("db.unreachable", { err: error }, "The database is unreachable; retrying");
      await startWait(retryDelayMs(attempt), context).done;
      continue;
    }
    checkRole(probe);
    return;
  }
};

/** Asks the database which role the hub runs as, and what it may bypass. */
export const probeRole = async (db: Kysely<HubTables>): Promise<RoleProbe> => {
  const { rows } = await sql<{ role: string; rolsuper: boolean; rolbypassrls: boolean }>`
    select current_user as role, rolsuper, rolbypassrls from pg_roles where rolname = current_user
  `.execute(db);
  const [row] = rows;
  if (row === undefined) {
    throw new Error("The database role of the hub is missing from pg_roles");
  }
  return { role: row.role, isSuperuser: row.rolsuper, bypassesRls: row.rolbypassrls };
};
