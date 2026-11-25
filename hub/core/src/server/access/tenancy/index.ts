import { addEnvironmentRoutes } from "./environment-routes.js";
import { addProjectRoutes } from "./project-routes.js";
import type { HubApp } from "../../app/index.js";
import type { EventBus } from "../../events/index.js";
import type { Authorization } from "../authorization/index.js";

/** Organizations' projects and their environments: docs/architecture/hub/access.md#model. */
export const addTenancyRoutes = (app: HubApp, authorization: Authorization, bus: EventBus): void => {
  addProjectRoutes(app, authorization, bus);
  addEnvironmentRoutes(app, authorization, bus);
};

export { normalizeName } from "./names.js";
export { listOrgIds } from "./queries.js";

export { environmentParams, nameBody, orgParams } from "./schemas.js";
