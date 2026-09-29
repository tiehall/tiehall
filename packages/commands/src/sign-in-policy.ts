import { getSignInPolicy, setSignInPolicy } from "@tiehall/catalog";
import { DEFAULT_SIGN_IN_POLICY, isSignInPolicy, signInPolicyChanged, signInPolicyText, type SignInPolicy } from "@tiehall/core";
import { installSettings } from "@tiehall/db";
import { eq } from "drizzle-orm";
import type { ReviewHandler } from "./confirmation-step.ts";
import { defineHandler, type Handlers } from "./execute.ts";
import type { OrgContext } from "./with-org.ts";

// The sign-in policy (sign-in: The sign-in policy; agent-safety: Actions that
// need the confirmation step; activity-log: Which actions are security events;
// design.md, Self-hosting decisions: S5 and S7). The install has one sign-in
// policy with two settings, "organization members and invited people", which
// a new install starts with, and "invited people only". Only an admin changes
// it, in the web UI, with the confirmation step; no agent surface offers the
// change. A change applies to the next sign-in (sign-in-admission.ts) and
// removes no member: under "invited people only", organization membership
// admits nobody who is not a member yet, while invites and existing
// memberships still admit. The change and its security event commit together.
// The web UI's sign-in policy page shows an admin the policy in force; that
// read is an admin action too.

/** The install's sign-in policy, read in the caller's transaction; the default until an admin changes it. */
export async function signInPolicyOf({ tx, orgId }: Pick<OrgContext, "tx" | "orgId">, lock = false): Promise<SignInPolicy> {
  const query = tx.select({ policy: installSettings.signInPolicy }).from(installSettings).where(eq(installSettings.orgId, orgId));
  const [row] = lock ? await query.for("update") : await query;
  return isSignInPolicy(row?.policy) ? row.policy : DEFAULT_SIGN_IN_POLICY;
}

export const SIGN_IN_POLICY_HANDLERS: Handlers = {
  [getSignInPolicy.id]: defineHandler(getSignInPolicy, async (_input, context) => ({ policy: await signInPolicyOf(context) })),

  [setSignInPolicy.id]: defineHandler(setSignInPolicy, async ({ policy }, context) => {
    const previousPolicy = await signInPolicyOf(context, true);
    if (previousPolicy === policy) return { policy, previousPolicy };
    return context.write(async (writer) => {
      await writer.tx
        .insert(installSettings)
        .values({ orgId: writer.orgId, signInPolicy: policy })
        .onConflictDoUpdate({ target: installSettings.orgId, set: { signInPolicy: policy } });
      await writer.record(signInPolicyChanged, { policy, previousPolicy });
      return { policy, previousPolicy };
    });
  }),
};

/** The review page of a change to the sign-in policy, in Tiehall's own words. */
export const SIGN_IN_POLICY_REVIEWS: Readonly<Record<string, ReviewHandler>> = {
  [setSignInPolicy.id]: async (input, context) => {
    const { policy } = input as { policy: SignInPolicy };
    const current = await signInPolicyOf(context);
    const lines =
      current === policy
        ? [{ text: `The install's sign-in policy is already ${signInPolicyText(current)}, so confirming changes nothing.` }]
        : [
            { text: `Change the install's sign-in policy from ${signInPolicyText(current)} to ${signInPolicyText(policy)}.` },
            {
              text:
                policy === "invited_only"
                  ? "From then on, membership of a connected GitHub organization admits nobody who is not a member yet: new members join only through an invite. Existing members keep signing in."
                  : "From then on, members of the GitHub organizations whose installations are connected can sign in and join as members, as can invited people.",
            },
            { text: "No member is removed." },
          ];
    return { title: "Change the sign-in policy", lines };
  },
};
