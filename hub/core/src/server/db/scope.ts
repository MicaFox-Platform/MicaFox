import { sql } from "kysely";
import type { Kysely, KyselyPlugin, Transaction } from "kysely";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Logger } from "pino";

/**
 * The hub's tables as Kysely sees them. They come with the migrations; until then no table is known, and a query
 * names its own with `withTables<...>()`, which `unknown` passes through unchanged.
 */
export type HubTables = unknown;

/** The three ways code gets the database: docs/architecture/hub/database.md#scoping-a-query. */
export interface Database {
  /** Runs `run` in a transaction that sees and writes only the rows of `orgId`. */
  forOrg: <T>(orgId: string, run: (db: Transaction<HubTables>) => Promise<T>) => Promise<T>;
  /** The global tables, without an organization; only `access/` and `db/` use it (ESLint). */
  global: Kysely<HubTables>;
  /**
   * Runs `run` in a transaction that sees every organization's rows, and logs `reason`, at `info` unless `logLevel`
   * says `debug` for work that repeats often and logs its own summary; for jobs such as retention.
   */
  system: <T>(
    reason: string,
    run: (db: Transaction<HubTables>) => Promise<T>,
    options?: { logLevel?: "info" | "debug" },
  ) => Promise<T>;
  /** Closes the pool, or PGlite; the hub calls it last when it stops. */
  close: () => Promise<void>;
}

/** A database call inside `forOrg` or `system` did not go through the transaction that call was given. */
export class NestedScopeError extends Error {
  constructor() {
    super("Inside db.forOrg() or db.system(), use the transaction they pass, not db again");
    this.name = "NestedScopeError";
  }
}

// Open while a scoped callback runs; a timer or promise the callback leaves behind keeps the store but sees it closed
interface Scope {
  isOpen: boolean;
}

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

const isInsideScope = (scopes: AsyncLocalStorage<Scope>): boolean => scopes.getStore()?.isOpen === true;

// A call to db inside a scoped callback would need a second connection: on PGlite, which has one, it would wait for
// itself forever, and on Postgres it would read outside the transaction. It fails at once on both instead.
const rejectInsideScope = (scopes: AsyncLocalStorage<Scope>): KyselyPlugin => ({
  transformQuery: (args) => {
    if (isInsideScope(scopes)) {
      throw new NestedScopeError();
    }
    return args.node;
  },
  transformResult: async (args) => await Promise.resolve(args.result),
});

/** Builds the three handles over one Kysely instance; `close` destroys it. */
export const createScopes = (kysely: Kysely<HubTables>, log: Logger): Database => {
  const scopes = new AsyncLocalStorage<Scope>();

  // Each setting is local to the transaction, so it is gone before the connection returns to the pool
  const runScoped = async <T>(
    settings: Readonly<Record<string, string>>,
    run: (db: Transaction<HubTables>) => Promise<T>,
  ): Promise<T> => {
    if (isInsideScope(scopes)) {
      throw new NestedScopeError();
    }
    return await kysely.transaction().execute(async (trx) => {
      for (const [name, value] of Object.entries(settings)) {
        await sql`select set_config(${name}, ${value}, true)`.execute(trx);
      }
      const scope: Scope = { isOpen: true };
      try {
        return await scopes.run(scope, async () => await run(trx));
      } finally {
        scope.isOpen = false;
      }
    });
  };

  return {
    forOrg: async (orgId, run) => {
      if (!UUID.test(orgId)) {
        throw new RangeError("db.forOrg() takes an organization id, which is a UUID");
      }
      return await runScoped({ "micafox.org_id": orgId }, run);
    },
    global: kysely.withPlugin(rejectInsideScope(scopes)),
    system: async (reason, run, options = {}) => {
      log[options.logLevel ?? "info"]({ reason }, "db.system");
      return await runScoped({ "micafox.system": "on" }, run);
    },
    close: async () => {
      await kysely.destroy();
    },
  };
};
