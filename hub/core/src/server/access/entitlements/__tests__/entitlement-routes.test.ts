import { afterEach, describe, expect, it } from "vitest";

import { openTenancyApp } from "../../../../../test/access/tenancy-app.js";
import type { TenancyApp } from "../../../../../test/access/tenancy-app.js";
import { ORG_A } from "../../../../../test/db/test-database.js";
import { paidFeature } from "../../../../../test/feature/fixtures.js";
import { defineExtension } from "../../../feature/index.js";
import type { EntitlementSource } from "../entitlements.js";

let tenancy: TenancyApp | undefined;

afterEach(async () => {
  await tenancy?.close();
  tenancy = undefined;
});

const open = async (sources: readonly EntitlementSource[] = []): Promise<TenancyApp> => {
  tenancy = await openTenancyApp({ extension: defineExtension({ features: [paidFeature("fixture")], sources }) });
  return tenancy;
};

describe("GET /api/v1/orgs/{orgId}/entitlements", () => {
  it("answers an empty list in S2, which grants nothing, to a member", async () => {
    const app = await open();

    const reply = await app.get("memberA", `/api/v1/orgs/${ORG_A}/entitlements`);

    expect(reply).toEqual({ status: 200, body: { entitlements: [] } });
  });

  it("lists what the sources grant the organization", async () => {
    const app = await open([async () => await Promise.resolve(new Set(["logs", "fixture-plan"]))]);

    const reply = await app.get("ownerA", `/api/v1/orgs/${ORG_A}/entitlements`);

    expect(reply).toEqual({ status: 200, body: { entitlements: ["fixture-plan", "logs"] } });
  });

  it("answers a non-member 404 and nobody 401", async () => {
    const app = await open();

    const replies = [
      await app.get("ownerB", `/api/v1/orgs/${ORG_A}/entitlements`),
      await app.get(undefined, `/api/v1/orgs/${ORG_A}/entitlements`),
    ];

    expect(replies.map(({ status }) => status)).toEqual([404, 401]);
  });
});
