export const STAFF_ROLES = [
  "super_admin",
  "returning_officer",
  "presiding_officer",
  "observer",
] as const;

export type StaffRole = (typeof STAFF_ROLES)[number];

export const ROLE_LABELS: Record<StaffRole, string> = {
  super_admin: "Super Admin",
  returning_officer: "Returning Officer",
  presiding_officer: "Presiding Officer",
  observer: "Observer",
};

/** Roles that must complete TOTP MFA (aal2) before any access. */
export const MFA_REQUIRED_ROLES: readonly StaffRole[] = ["super_admin", "returning_officer"];

export interface RoleAssignment {
  id: string;
  role: StaffRole;
  electionId: string | null;
  boothId: string | null;
}

export interface AuthTimes {
  /** Epoch seconds of the last password authentication, from the JWT `amr` claim. */
  password: number | null;
  /** Epoch seconds of the last TOTP verification, from the JWT `amr` claim. */
  totp: number | null;
}

/** An authenticated, active staff member acting in the current request. */
export interface Actor {
  userId: string;
  sessionId: string;
  email: string;
  displayName: string;
  roles: RoleAssignment[];
  aal: "aal1" | "aal2";
  authTimes: AuthTimes;
}

export function requiresMfa(roles: readonly RoleAssignment[]): boolean {
  return roles.some((r) => MFA_REQUIRED_ROLES.includes(r.role));
}

export function isPrivileged(actor: Pick<Actor, "roles">): boolean {
  return requiresMfa(actor.roles);
}

export function superAdminGrant(actor: Pick<Actor, "roles">): RoleAssignment | null {
  return actor.roles.find((r) => r.role === "super_admin") ?? null;
}

/** The assignment that scopes `actor` to `electionId` with one of `roles`, if any. */
export function electionGrant(
  actor: Pick<Actor, "roles">,
  electionId: string,
  roles: readonly StaffRole[],
): RoleAssignment | null {
  return (
    actor.roles.find(
      (r) =>
        roles.includes(r.role) && r.electionId === electionId && r.role !== "presiding_officer",
    ) ?? null
  );
}

/** The Presiding Officer assignment for exactly this Polling Booth, if any. */
export function boothGrant(actor: Pick<Actor, "roles">, boothId: string): RoleAssignment | null {
  return actor.roles.find((r) => r.role === "presiding_officer" && r.boothId === boothId) ?? null;
}
