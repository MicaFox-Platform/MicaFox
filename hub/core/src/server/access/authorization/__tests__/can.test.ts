import { describe, expect, it } from "vitest";

import { createCan } from "../can.js";
import type { Actor, Role } from "../can.js";

const ORG = "0b6f3a52-6a3e-4e55-9d0c-6f1c1d2b8a01";
const OTHER_ORG = "4d1e9c07-21b4-4f0a-8c3e-0a9f7e5d6b02";

const can = createCan(["debugger"]);

const actorWith = (role: Role): Actor => ({ userId: "u1", memberships: [{ orgId: ORG, role }] });

describe("can", () => {
  it.each(["owner", "admin"] as const)("lets an %s do an admin action", (role) => {
    expect(can(actorWith(role), "project.create", { orgId: ORG })).toBe(true);
  });

  it("refuses a member an admin action", () => {
    expect(can(actorWith("member"), "environment.update", { orgId: ORG })).toBe(false);
  });

  it.each(["owner", "admin", "member"] as const)("lets an %s do a member action", (role) => {
    expect(can(actorWith(role), "project.read", { orgId: ORG })).toBe(true);
  });

  it.each(["owner", "admin", "member"] as const)("lets an %s do a feature's action", (role) => {
    expect(can(actorWith(role), "debugger.breakpoint.create", { orgId: ORG })).toBe(true);
  });

  it("refuses an action in an organization the actor does not belong to", () => {
    expect(can(actorWith("owner"), "project.read", { orgId: OTHER_ORG })).toBe(false);
  });

  it("refuses a feature's action in an organization the actor does not belong to", () => {
    expect(can(actorWith("owner"), "debugger.breakpoint.create", { orgId: OTHER_ORG })).toBe(false);
  });

  it.each(["project.delete", "projects.create", "key.delete", "member.invite"])(
    "refuses %s to a member: it is neither a core action nor of a feature the hub runs",
    (action) => {
      expect(can(actorWith("member"), action, { orgId: ORG })).toBe(false);
    },
  );

  it("refuses an owner an action of a feature the hub does not run", () => {
    expect(can(actorWith("owner"), "billing.invoice.read", { orgId: ORG })).toBe(false);
  });

  it.each(["project", "debugger", "Debugger.run", "debugger."])(
    "refuses %s, which is not <feature>.<action>",
    (action) => {
      expect(can(actorWith("owner"), action, { orgId: ORG })).toBe(false);
    },
  );

  it("uses the role of the organization asked about", () => {
    const actor: Actor = {
      userId: "u1",
      memberships: [
        { orgId: ORG, role: "member" },
        { orgId: OTHER_ORG, role: "admin" },
      ],
    };

    expect([can(actor, "project.create", { orgId: ORG }), can(actor, "project.create", { orgId: OTHER_ORG })]).toEqual([
      false,
      true,
    ]);
  });
});
