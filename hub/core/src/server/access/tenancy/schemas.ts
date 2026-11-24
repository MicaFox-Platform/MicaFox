import { Type } from "typebox";
import type { Static } from "typebox";

import { pageQueryProperties } from "../../../schema/index.js";

const uuid = Type.String({ format: "uuid" });

// The raw name is bounded here, the rules of a name are `normalizeName`'s
export const nameBody = Type.Object({ name: Type.String({ maxLength: 256 }) });

export const pageQuery = Type.Object(pageQueryProperties);

/** A list's query. */
export type PageRequest = Static<typeof pageQuery>;

export const orgParams = Type.Object({ orgId: uuid });
export const projectParams = Type.Object({ projectId: uuid });
export const environmentParams = Type.Object({ environmentId: uuid });

export const projectReply = Type.Object({
  id: uuid,
  orgId: uuid,
  name: Type.String(),
  createdAt: Type.String({ format: "date-time" }),
});

export const environmentReply = Type.Object({
  id: uuid,
  projectId: uuid,
  name: Type.String(),
  createdAt: Type.String({ format: "date-time" }),
});
