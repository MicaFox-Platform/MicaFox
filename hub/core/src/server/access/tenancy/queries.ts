import { CamelCasePlugin, sql } from "kysely";
import type { Selectable, Transaction } from "kysely";

import type { PageRequest } from "./schemas.js";
import type { EnvironmentsTable, ProjectsTable, TenancyTables } from "./tables.js";
import { DEFAULT_PAGE_LIMIT } from "../../../schema/index.js";
import { HttpProblem } from "../../app/index.js";
import type { HubTables } from "../../db/index.js";

/** A project as the API answers it. */
export interface Project {
  id: string;
  orgId: string;
  name: string;
  createdAt: string;
}

/** An environment as the API answers it. */
export interface Environment {
  id: string;
  projectId: string;
  name: string;
  createdAt: string;
}

/** A page of a list: `nextCursor` is missing on the last one. */
export interface Page<Item> {
  items: Item[];
  nextCursor?: string;
}

const UNIQUE_VIOLATION = "23505";

type Db = Transaction<TenancyTables>;
type ProjectRow = Selectable<ProjectsTable>;
type EnvironmentRow = Selectable<EnvironmentsTable>;

// Kysely types the tables of a query by name, and `HubTables` knows none yet; columns are `snake_case` in the database
const camelCase = new CamelCasePlugin();
const tables = (trx: Transaction<HubTables>): Db => trx.$extendTables<TenancyTables>().withPlugin(camelCase);

const toProject = (row: ProjectRow): Project => ({
  id: row.id,
  orgId: row.orgId,
  name: row.name,
  createdAt: row.createdAt.toISOString(),
});

const toEnvironment = (row: EnvironmentRow): Environment => ({
  id: row.id,
  projectId: row.projectId,
  name: row.name,
  createdAt: row.createdAt.toISOString(),
});

// Names are unique within their parent, so the lower-cased name alone orders a list and marks where a page ends
const encodeCursor = (sortKey: string): string => Buffer.from(sortKey).toString("base64url");

// A cursor this hub did not make, which would not survive the round trip or holds what Postgres refuses, is a 400
const decodeCursor = (cursor: string): string => {
  const sortKey = Buffer.from(cursor, "base64url").toString();
  if (encodeCursor(sortKey) !== cursor || sortKey.includes("\u0000")) {
    throw new HttpProblem("validation", {
      detail: "cursor: is not a cursor of this list",
      errors: [{ path: "/cursor", in: "query", message: "is not a cursor of this list" }],
    });
  }
  return sortKey;
};

const pageOfRows = <Row extends { sortKey: string }, Item>(
  rows: Row[],
  limit: number,
  toItem: (row: Row) => Item,
): Page<Item> => {
  const rowsOfPage = rows.slice(0, limit);
  const last = rowsOfPage.at(-1);
  const hasMore = rows.length > limit && last !== undefined;
  return {
    items: rowsOfPage.map((row) => toItem(row)),
    ...(hasMore ? { nextCursor: encodeCursor(last.sortKey) } : {}),
  };
};

/** Runs `run`, and turns a name that is taken, which a unique index refuses, into 409 `conflict`. */
export const failOnTakenName = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === UNIQUE_VIOLATION) {
      throw new HttpProblem("conflict", { detail: "name: is taken" });
    }
    throw error;
  }
};

/** The projects of the organization the transaction is scoped to, by name. */
export const listProjects = async (trx: Transaction<HubTables>, page: PageRequest): Promise<Page<Project>> => {
  // Validation fills in the default `limit`, which the type cannot know
  const limit = page.limit ?? DEFAULT_PAGE_LIMIT;
  let query = tables(trx)
    .selectFrom("projects")
    .selectAll()
    .select(sql<string>`lower(name)`.as("sortKey"))
    .orderBy(sql`lower(name)`)
    .limit(limit + 1);
  if (page.cursor !== undefined) {
    query = query.where(sql<boolean>`lower(name) > ${decodeCursor(page.cursor)}`);
  }
  return pageOfRows(await query.execute(), limit, toProject);
};

/** The project `id` of the scoped organization, or `undefined`. */
export const getProject = async (trx: Transaction<HubTables>, id: string): Promise<Project | undefined> => {
  const row = await tables(trx).selectFrom("projects").selectAll().where("id", "=", id).executeTakeFirst();
  return row === undefined ? undefined : toProject(row);
};

/** Adds a project with its `production` environment. */
export const insertProject = async (trx: Transaction<HubTables>, orgId: string, name: string): Promise<Project> => {
  const db = tables(trx);
  const project = await db.insertInto("projects").values({ orgId, name }).returningAll().executeTakeFirstOrThrow();
  await db.insertInto("environments").values({ orgId, projectId: project.id, name: "production" }).execute();
  return toProject(project);
};

/** Renames the project `id` of the scoped organization. */
export const renameProject = async (trx: Transaction<HubTables>, id: string, name: string): Promise<Project> =>
  toProject(
    await tables(trx)
      .updateTable("projects")
      .set({ name })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow(),
  );

/** The environments of a project of the scoped organization, by name. */
export const listEnvironments = async (
  trx: Transaction<HubTables>,
  projectId: string,
  page: PageRequest,
): Promise<Page<Environment>> => {
  // Validation fills in the default `limit`, which the type cannot know
  const limit = page.limit ?? DEFAULT_PAGE_LIMIT;
  let query = tables(trx)
    .selectFrom("environments")
    .selectAll()
    .select(sql<string>`lower(name)`.as("sortKey"))
    .where("projectId", "=", projectId)
    .orderBy(sql`lower(name)`)
    .limit(limit + 1);
  if (page.cursor !== undefined) {
    query = query.where(sql<boolean>`lower(name) > ${decodeCursor(page.cursor)}`);
  }
  return pageOfRows(await query.execute(), limit, toEnvironment);
};

/** The environment `id` of the scoped organization, or `undefined`. */
export const getEnvironment = async (trx: Transaction<HubTables>, id: string): Promise<Environment | undefined> => {
  const row = await tables(trx).selectFrom("environments").selectAll().where("id", "=", id).executeTakeFirst();
  return row === undefined ? undefined : toEnvironment(row);
};

/** Adds an environment to a project of the scoped organization. */
export const insertEnvironment = async (
  trx: Transaction<HubTables>,
  project: { id: string; orgId: string },
  name: string,
): Promise<Environment> =>
  toEnvironment(
    await tables(trx)
      .insertInto("environments")
      .values({ orgId: project.orgId, projectId: project.id, name })
      .returningAll()
      .executeTakeFirstOrThrow(),
  );

/** Renames the environment `id` of the scoped organization. */
export const renameEnvironment = async (trx: Transaction<HubTables>, id: string, name: string): Promise<Environment> =>
  toEnvironment(
    await tables(trx)
      .updateTable("environments")
      .set({ name })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow(),
  );
