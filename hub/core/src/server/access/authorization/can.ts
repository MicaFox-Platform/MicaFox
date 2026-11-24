/** What a user is in an organization: docs/architecture/hub/access.md#model. */
export type Role = "owner" | "admin" | "member";

/** A user's role in one organization. */
export interface Membership {
  orgId: string;
  role: Role;
}

/** Who makes a request: a user and every organization they belong to. */
export interface Actor {
  userId: string;
  memberships: readonly Membership[];
}

/** What an action is done to; in S2 only the organization it belongs to counts. */
export interface Resource {
  orgId: string;
}

/** Whether `actor` may do `action` to `resource`. */
export type Can = (actor: Actor, action: string, resource: Resource) => boolean;

type Level = "member" | "admin";

// The actions of the core, by who may do them; a feature's are `<feature>.<action>`
const CORE_ACTIONS: ReadonlyMap<string, Level> = new Map<string, Level>([
  ["project.read", "member"],
  ["project.create", "admin"],
  ["project.update", "admin"],
  ["environment.read", "member"],
  ["environment.create", "admin"],
  ["environment.update", "admin"],
]);

const FEATURE_ACTION = /^([a-z][a-z0-9-]*)\.[a-z][a-z0-9.-]*$/;

/**
 * Builds `can()` for the features the hub runs: an admin or owner may do everything, a member the member actions and
 * every `<feature>.<action>` of those features, and anyone outside the organization nothing. Any other action, such
 * as a typo or a core action not written yet, is refused, so a mistake never opens a door.
 */
export const createCan = (features: readonly string[]): Can => {
  const featureNames: ReadonlySet<string> = new Set(features);
  const levelOf = (action: string): Level | undefined => {
    const feature = FEATURE_ACTION.exec(action)?.[1];
    return CORE_ACTIONS.get(action) ?? (feature !== undefined && featureNames.has(feature) ? "member" : undefined);
  };
  return (actor, action, resource) => {
    const membership = actor.memberships.find((candidate) => candidate.orgId === resource.orgId);
    const level = levelOf(action);
    if (membership === undefined || level === undefined) {
      return false;
    }
    return level === "member" || membership.role === "owner" || membership.role === "admin";
  };
};
