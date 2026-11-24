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
import { inOwningOrg, requireCan } from "../authorization/index.js";
import type { Authorization } from "../authorization/index.js";

/**
 * The routes of `docs/api/hub/http.md#projects-and-environments` that list, create and rename environments. Only an
 * organization that holds the id may answer 403 or a 400 about the body; any other answers 404.
 */
export const addEnvironmentRoutes = (app: HubApp, authorization: Authorization): void => {
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

  app.post(
    "/api/v1/projects/:projectId/environments",
    { schema: { params: projectParams, body: nameBody, response: { 201: environmentReply } } },
    async (request, reply) => {
      const environment = await failOnTakenName(
        async () =>
          await inOwningOrg(request, authorization, async (trx, context) => {
            const project = await getProject(trx, request.params.projectId);
            if (project === undefined) {
              return undefined;
            }
            requireCan(context, "environment.create");
            return await insertEnvironment(trx, project, normalizeName(request.body.name));
          }),
      );
      return await reply.code(201).send(environment);
    },
  );

  app.patch(
    "/api/v1/environments/:environmentId",
    { schema: { params: environmentParams, body: nameBody, response: { 200: environmentReply } } },
    async (request) =>
      await failOnTakenName(
        async () =>
          await inOwningOrg(request, authorization, async (trx, context) => {
            if ((await getEnvironment(trx, request.params.environmentId)) === undefined) {
              return undefined;
            }
            requireCan(context, "environment.update");
            return await renameEnvironment(trx, request.params.environmentId, normalizeName(request.body.name));
          }),
      ),
  );
};
