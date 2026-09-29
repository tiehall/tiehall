// The sign-in policy (sign-in: The sign-in policy; design.md, Self-hosting
// decisions: S5). The install has one sign-in policy with two settings:
// "organization members and invited people", which a new install starts
// with, and "invited people only". Under the second, membership of a GitHub
// organization admits nobody who is not a member of the install yet, while
// invites and existing memberships still admit. Only an admin changes it, in
// the web UI, with the confirmation step.

export const SIGN_IN_POLICIES = ["organization_members_and_invited", "invited_only"] as const;
export type SignInPolicy = (typeof SIGN_IN_POLICIES)[number];

/** The policy a new install starts with. */
export const DEFAULT_SIGN_IN_POLICY: SignInPolicy = "organization_members_and_invited";

/** Whether a value names one of the two settings. */
export function isSignInPolicy(value: unknown): value is SignInPolicy {
  return (SIGN_IN_POLICIES as readonly unknown[]).includes(value);
}

/** Whether the policy lets membership of a GitHub organization admit a person who is not a member yet. */
export function admitsOrganizationMembers(policy: SignInPolicy): boolean {
  return policy === "organization_members_and_invited";
}

/** The setting in Tiehall's own words, as pages and reviews name it. */
export function signInPolicyText(policy: SignInPolicy): string {
  return policy === "organization_members_and_invited" ? "organization members and invited people" : "invited people only";
}
