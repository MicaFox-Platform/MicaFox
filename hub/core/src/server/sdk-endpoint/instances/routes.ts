import { environmentExists, listInstances } from "./queries.js";
import { environmentParams, instanceReply, listQuery } from "./schemas.js";
import { pageOf } from "../../../schema/index.js";
import { inOwningOrg, requireCan } from "../../access/index.js";
import type { Authorization } from "../../access/index.js";
import type { HubApp } from "../../app/index.js";

/**
 * `GET /api/v1/environments/{environmentId}/instances` of `docs/api/hub/http.md#instances`. Only an organization
 * that holds the environment may answer 403; any other answers 404. `onlineIds` are the instances this replica holds
 * a session for.
 */
export const addInstanceRoutes = (
  app: HubApp,
  authorization: Authorization,
  onlineIds: (environmentId: string) => string[],
): void => {
  app.get(
    "/api/v1/environments/:environmentId/instances",
    { schema: { params: environmentParams, querystring: listQuery, response: { 200: pageOf(instanceReply) } } },
    async (request) =>
      await inOwningOrg(request, authorization, async (trx, context) => {
        const { environmentId } = request.params;
        if (!(await environmentExists(trx, environmentId))) {
          return undefined;
        }
        requireCan(context, "instance.read");
        return await listInstances(trx, { environmentId, onlineIds: onlineIds(environmentId) }, request.query);
      }),
  );
};
