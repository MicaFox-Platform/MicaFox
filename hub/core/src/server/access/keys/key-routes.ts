import {
  countActiveKeys,
  findActiveKey,
  findEnvironment,
  insertKey,
  listActiveKeys,
  lockEnvironment,
  MAX_ACTIVE_KEYS,
  revokeKey,
} from "./queries.js";
import type { RevokeHooks } from "./revoke-hooks.js";
import { createdKeyReply, keyParams, keyReply, noContent } from "./schemas.js";
import { pageOf } from "../../../schema/index.js";
import { HttpProblem } from "../../app/index.js";
import type { HubApp } from "../../app/index.js";
import { inOwningOrg, requireCan } from "../authorization/index.js";
import type { Authorization } from "../authorization/index.js";
import { environmentParams, nameBody, normalizeName } from "../tenancy/index.js";
import { createToken, hashToken } from "../tokens/index.js";

const KEY_PREFIX = "mfx_pk_";
// What the keys list shows to tell keys apart: `mfx_pk_` and 5 characters of the secret
const DISPLAY_PREFIX_LENGTH = 12;

/** The app's `MICAFOX_HUB_URL`: the SDK endpoint `/sdk` under the public URL, over `wss:`, or `ws:` on plain HTTP. */
const sdkUrlOf = (publicUrl: string): string => {
  const url = new URL(publicUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/sdk`;
  return url.toString();
};

/** What the key routes need from the hub. */
export interface KeyRouteOptions {
  authorization: Authorization;
  /** The URL users open; the SDK's URL is made from it. */
  publicUrl: () => string;
  hooks: RevokeHooks;
}

/**
 * The routes of `docs/api/hub/http.md#project-keys`. Every one is for admins; only an organization that holds the id
 * may answer 403 or a 400 about the body, any other answers 404. A key is logged by its prefix, never its token.
 */
export const addKeyRoutes = (app: HubApp, options: KeyRouteOptions): void => {
  addListRoute(app, options);
  addCreateRoute(app, options);
  addRevokeRoute(app, options);
};

const addListRoute = (app: HubApp, { authorization }: KeyRouteOptions): void => {
  app.get(
    "/api/v1/environments/:environmentId/keys",
    { schema: { params: environmentParams, response: { 200: pageOf(keyReply) } } },
    async (request) =>
      await inOwningOrg(request, authorization, async (trx, context) => {
        const environment = await findEnvironment(trx, request.params.environmentId);
        if (environment === undefined) {
          return undefined;
        }
        requireCan(context, "key.read");
        return { items: await listActiveKeys(trx, environment) };
      }),
  );
};

const addCreateRoute = (app: HubApp, options: KeyRouteOptions): void => {
  const { authorization } = options;
  app.post(
    "/api/v1/environments/:environmentId/keys",
    { schema: { params: environmentParams, body: nameBody, response: { 201: createdKeyReply } } },
    async (request, reply) => {
      const token = createToken(KEY_PREFIX);
      const created = await inOwningOrg(request, authorization, async (trx, context) => {
        const environment = await lockEnvironment(trx, request.params.environmentId);
        if (environment === undefined) {
          return undefined;
        }
        requireCan(context, "key.create");
        const name = normalizeName(request.body.name);
        if ((await countActiveKeys(trx, environment)) >= MAX_ACTIVE_KEYS) {
          throw new HttpProblem("conflict", {
            detail: `environment: already has ${String(MAX_ACTIVE_KEYS)} active keys; revoke one first`,
          });
        }
        const key = await insertKey(trx, {
          environment,
          name,
          tokenHash: hashToken(token),
          displayPrefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
          createdBy: request.actor.userId,
        });
        return { key, environment };
      });
      request.log.info(
        {
          event: "key.created",
          userId: request.actor.userId,
          orgId: created.environment.orgId,
          environmentId: created.environment.id,
          keyId: created.key.id,
          keyPrefix: created.key.prefix,
        },
        "A project key was created",
      );
      return await reply.code(201).send({ ...created.key, token, hubUrl: sdkUrlOf(options.publicUrl()) });
    },
  );
};

const addRevokeRoute = (app: HubApp, { authorization, hooks }: KeyRouteOptions): void => {
  app.delete(
    "/api/v1/keys/:keyId",
    { schema: { params: keyParams, response: { 204: noContent } } },
    async (request, reply) => {
      const revoked = await inOwningOrg(request, authorization, async (trx, context) => {
        const orgId = context.membership.orgId;
        // A key's row is not under row-level security, so only the organization named in it may find it
        if ((await findActiveKey(trx, orgId, request.params.keyId)) === undefined) {
          return undefined;
        }
        requireCan(context, "key.revoke");
        return await revokeKey(trx, orgId, request.params.keyId);
      });
      request.log.info(
        {
          event: "key.revoked",
          userId: request.actor.userId,
          orgId: revoked.orgId,
          environmentId: revoked.environmentId,
          keyId: revoked.keyId,
          keyPrefix: revoked.prefix,
        },
        "A project key was revoked",
      );
      await hooks.run(revoked, request.log);
      return await reply.code(204).send(null);
    },
  );
};
