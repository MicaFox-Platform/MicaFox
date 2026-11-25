import { normalizeName } from "./names.js";
import {
  failOnTakenName,
  getEnvironment,
  getProject,
  insertEnvironment,
  listEnvironments,
  renameEnvironment,
} from "./queries.js";
import { environmentParams, environmentReply, nameBody, pageQuery, projectParams } from "./schemas.js";
import { pageOf } from "../../../schema/index.js";
import type { HubApp } from "../../app/index.js";
import type { EventBus } from "../../events/index.js";
import { inOwningOrg, requireCan } from "../authorization/index.js";
import type { Authorization } from "../authorization/index.js";

/**
 * The routes of `docs/api/hub/http.md#projects-and-environments` that list, create and rename environments. Only an
 * organization that holds the id may answer 403 or a 400 about the body; any other answers 404.
 */
export const addEnvironmentRoutes = (app: HubApp, authorization: Authorization, bus: EventBus): void => {
  addListRoute(app, authorization);
  addCreateRoute(app, authorization, bus);
  addRenameRoute(app, authorization, bus);
};

const addListRoute = (app: HubApp, authorization: Authorization): void => {
  app.get(
    "/api/v1/projects/:projectId/environments",
    { schema: { params: projectParams, querystring: pageQuery, response: { 200: pageOf(environmentReply) } } },
    async (request) =>
      await inOwningOrg(request, authorization, async (trx, context) => {
        if ((await getProject(trx, request.params.projectId)) === undefined) {
          return undefined;
        }
        requireCan(context, "environment.read");
        return await listEnvironments(trx, request.params.projectId, request.query);
      }),
  );
};

const addCreateRoute = (app: HubApp, authorization: Authorization, bus: EventBus): void => {
  app.post(
    "/api/v1/projects/:projectId/environments",
    { schema: { params: projectParams, body: nameBody, response: { 201: environmentReply } } },
    async (request, reply) => {
      const { environment, orgId } = await failOnTakenName(
        async () =>
          await inOwningOrg(request, authorization, async (trx, context) => {
            const project = await getProject(trx, request.params.projectId);
            if (project === undefined) {
              return undefined;
            }
            requireCan(context, "environment.create");
            const created = await insertEnvironment(trx, project, normalizeName(request.body.name));
            return { environment: created, orgId: project.orgId };
          }),
      );
      bus.publish({
        type: "environment.created",
        orgId,
        environmentId: environment.id,
        actor: { userId: request.actor.userId },
        data: { projectId: environment.projectId, environmentId: environment.id },
      });
      return await reply.code(201).send(environment);
    },
  );
};

const addRenameRoute = (app: HubApp, authorization: Authorization, bus: EventBus): void => {
  app.patch(
    "/api/v1/environments/:environmentId",
    { schema: { params: environmentParams, body: nameBody, response: { 200: environmentReply } } },
    async (request) => {
      const { environment, orgId } = await failOnTakenName(
        async () =>
          await inOwningOrg(request, authorization, async (trx, context) => {
            if ((await getEnvironment(trx, request.params.environmentId)) === undefined) {
              return undefined;
            }
            requireCan(context, "environment.update");
            const renamed = await renameEnvironment(
              trx,
              request.params.environmentId,
              normalizeName(request.body.name),
            );
            return { environment: renamed, orgId: context.membership.orgId };
          }),
      );
      bus.publish({
        type: "environment.updated",
        orgId,
        environmentId: environment.id,
        actor: { userId: request.actor.userId },
        data: { projectId: environment.projectId, environmentId: environment.id },
      });
      return environment;
    },
  );
};
