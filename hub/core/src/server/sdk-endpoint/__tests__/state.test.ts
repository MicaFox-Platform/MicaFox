import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { openJobsDatabase } from "../../../../test/db/jobs-database.js";
import { ORG_A } from "../../../../test/db/test-database.js";
import type { TestDatabase } from "../../../../test/db/test-database.js";
import { createManualClock } from "../../../../test/server/manual-clock.js";
import { createEvents } from "../../events/index.js";
import type { HubEvent } from "../../events/index.js";
import { createSdkResend } from "../state.js";

const PROJECT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const ENVIRONMENT = "9b2f4c1e-3d5a-4e8b-a1c6-2f7d8e9a0b11";
const opened: TestDatabase[] = [];

afterEach(async () => {
  await Promise.all(
    opened.splice(0).map(async (test) => {
      await test.close();
    }),
  );
});

const setup = async () => {
  const test = await openJobsDatabase();
  opened.push(test);
  await test.db.system("test: add an environment", async (trx) => {
    await sql`insert into projects (id, org_id, name) values (${PROJECT}, ${ORG_A}, 'Billing')`.execute(trx);
    await sql`insert into environments (id, org_id, project_id, name) values (${ENVIRONMENT}, ${ORG_A}, ${PROJECT}, 'production')`.execute(
      trx,
    );
  });
  const { bus } = createEvents({ log: test.logger, timers: createManualClock().clock });
  const published: HubEvent[] = [];
  bus.subscribe((event) => published.push(event));
  return { test, published, sdk: createSdkResend({ db: test.db, bus, log: test.logger }) };
};

describe("sdk.resend", () => {
  it("publishes the resend event of the environment's organization on the bus", async () => {
    const { sdk, published } = await setup();

    await sdk.resend(ENVIRONMENT, "debugger");

    expect(published).toEqual([
      {
        type: "sdk.state.resend",
        orgId: ORG_A,
        environmentId: ENVIRONMENT,
        actor: { userId: "system" },
        data: { module: "debugger" },
      },
    ]);
  });

  it("publishes nothing for an environment that is gone", async () => {
    const { sdk, published } = await setup();

    await sdk.resend("0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f", "debugger");

    expect(published).toEqual([]);
  });

  it("does not throw when the database cannot answer, and logs it", async () => {
    const { sdk, test, published } = await setup();

    await sdk.resend("not-a-uuid", "debugger");

    expect([published, test.log.lines().filter((line) => line.msg === "sdk.resend-failed")]).toEqual([
      [],
      [expect.objectContaining({ environmentId: "not-a-uuid", module: "debugger" })],
    ]);
  });
});
