import { normalizeName } from "./names.js";
import { failOnTakenName, getProject, insertProject, listProjects, renameProject } from "./queries.js";
import { nameBody, orgParams, pageQuery, projectParams, projectReply } from "./schemas.js";
import { pageOf } from "../../../schema/index.js";
import type { HubApp } from "../../app/index.js";
import type { EventBus } from "../../events/index.js";
import { inOrganization, inOwningOrg, requireCan } from "../authorization/index.js";
import type { Authorization } from "../authorization/index.js";

// The projects of an organization, whose id the path names
const addOrgProjectRoutes = (app: HubApp, authorization: Authorization, bus: EventBus): void => {
  app.get(
    "/api/v1/orgs/:orgId/projects",
    { schema: { params: orgParams, querystring: pageQuery, response: { 200: pageOf(projectReply) } } },
    async (request) => {
      const context = inOrganization(request, authorization, request.params.orgId);
      requireCan(context, "project.read");
      return await context.forOrg(async (trx) => await listProjects(trx, request.query));
    },
  );

  app.post(
    "/api/v1/orgs/:orgId/projects",
    { schema: { params: orgParams, body: nameBody, response: { 201: projectReply } } },
    async (request, reply) => {
      const context = inOrganization(request, authorization, request.params.orgId);
      requireCan(context, "project.create");
      const name = normalizeName(request.body.name);
      const project = await failOnTakenName(
        async () => await context.forOrg(async (trx) => await insertProject(trx, context.membership.orgId, name)),
      );
      bus.publish({
        type: "project.created",
        orgId: project.orgId,
        actor: { userId: request.actor.userId },
        data: { projectId: project.id },
      });
      return await reply.code(201).send(project);
    },
  );
};

// One project, whose organization only its id says. Only an organization that holds it may answer 403 or a 400 about
// the body; any other answers 404, as if it did not exist
const addProjectByIdRoutes = (app: HubApp, authorization: Authorization, bus: EventBus): void => {
  app.get(
    "/api/v1/projects/:projectId",
    { schema: { params: projectParams, response: { 200: projectReply } } },
    async (request) =>
      await inOwningOrg(request, authorization, async (trx, context) => {
        const project = await getProject(trx, request.params.projectId);
        if (project !== undefined) {
          requireCan(context, "project.read");
        }
        return project;
      }),
  );

  app.patch(
    "/api/v1/projects/:projectId",
    { schema: { params: projectParams, body: nameBody, response: { 200: projectReply } } },
    async (request) => {
      const project = await failOnTakenName(
        async () =>
          await inOwningOrg(request, authorization, async (trx, context) => {
            if ((await getProject(trx, request.params.projectId)) === undefined) {
              return undefined;
            }
            requireCan(context, "project.update");
            return await renameProject(trx, request.params.projectId, normalizeName(request.body.name));
          }),
      );
      bus.publish({
        type: "project.updated",
        orgId: project.orgId,
        actor: { userId: request.actor.userId },
        data: { projectId: project.id },
      });
      return project;
    },
  );
};

/** The routes of `docs/api/hub/http.md#projects-and-environments` that list, create, read and rename projects. */
export const addProjectRoutes = (app: HubApp, authorization: Authorization, bus: EventBus): void => {
  addOrgProjectRoutes(app, authorization, bus);
  addProjectByIdRoutes(app, authorization, bus);
};
