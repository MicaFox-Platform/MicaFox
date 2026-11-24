import { addEnvironmentRoutes } from "./environment-routes.js";
import { addProjectRoutes } from "./project-routes.js";
import type { HubApp } from "../../app/index.js";
import type { Authorization } from "../authorization/index.js";

/** Organizations' projects and their environments: docs/architecture/hub/access.md#model. */
export const addTenancyRoutes = (app: HubApp, authorization: Authorization): void => {
  addProjectRoutes(app, authorization);
  addEnvironmentRoutes(app, authorization);
};

export { normalizeName } from "./names.js";
