import { Type } from "typebox";
import type { Static } from "typebox";

import { FIELD_LIMITS } from "./fields.js";
import { pageQueryProperties } from "../../../schema/index.js";

export const environmentParams = Type.Object({ environmentId: Type.String({ format: "uuid" }) });

/** The list's query: the page, and the filters. */
export const listQuery = Type.Object({
  ...pageQueryProperties,
  online: Type.Optional(Type.Boolean()),
  // A stored service never holds NUL, which Postgres would refuse to compare with
  service: Type.Optional(Type.String({ maxLength: FIELD_LIMITS.service, pattern: "^[^\\u0000]*$" })),
});

/** What `GET /api/v1/environments/{environmentId}/instances` is asked. */
export type ListRequest = Static<typeof listQuery>;

const nameAndVersion = Type.Object({ name: Type.String(), version: Type.String() });

export const instanceReply = Type.Object({
  id: Type.String(),
  online: Type.Boolean(),
  service: Type.Optional(Type.String()),
  labels: Type.Record(Type.String(), Type.String()),
  hostname: Type.String(),
  pid: Type.Integer(),
  sdk: nameAndVersion,
  runtime: nameAndVersion,
  modules: Type.Array(Type.String()),
  commit: Type.Optional(Type.String()),
  protocolVersion: Type.Integer(),
  keyPrefix: Type.String(),
  connectedAt: Type.String({ format: "date-time" }),
  lastSeenAt: Type.String({ format: "date-time" }),
});

/** An instance as the API answers it. */
export type InstanceReply = Static<typeof instanceReply>;
