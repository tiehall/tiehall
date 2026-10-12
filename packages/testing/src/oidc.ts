import { createSign, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";

// GitHub Actions OIDC tokens for tests (agent-access: CI authenticates with
// GitHub Actions OIDC bound to registered repositories; design.md, Technical
// decisions: T7 and T17). GitHub Actions gives each run that asks for it a
// JSON web token, signed with RS256 by its issuer,
// https://token.actions.githubusercontent.com, whose public keys it publishes
// as a JSON Web Key Set. A test issuer here holds a key pair of its own and
// publishes its public key as such a set, which a test hands to the install in
// place of GitHub's; it signs tokens with the claims GitHub gives a run, which
// a test can change one by one: by default a push to main that runs
// .github/workflows/contract.yml, and for a run for a pull request, the pull
// request's merge ref, with the pairs of `ref` and `job_workflow_ref` GitHub
// issues (decisions-from-groups-15-28, D55 (61)). It signs with node:crypto,
// apart from the library the install verifies with. A second key, which the
// set does not hold, signs a token that is not the issuer's.

/** GitHub Actions' OIDC issuer, as every token it signs names it. */
export const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";

/** The claims of a GitHub Actions OIDC token that Tiehall reads, with the others GitHub gives. */
export interface ActionsClaims {
  iss: string;
  /** The audience the run asked for, such as the install's URL; a list holds several. */
  aud: string | string[];
  sub: string;
  jti: string;
  /** Seconds since the epoch. */
  iat: number;
  nbf: number;
  exp: number;
  repository: string;
  repository_id: string;
  repository_owner: string;
  repository_owner_id: string;
  job_workflow_ref: string;
  workflow_ref: string;
  ref: string;
  sha: string;
  event_name: string;
  run_id: string;
}

export interface ActionsRun {
  /** The audience the run asks for: the install's URL. */
  audience: string;
  /** The repository the run is in, as owner/name, and GitHub's ids of it and its owner. */
  repository: string;
  repositoryId: number | string;
  repositoryOwnerId: number | string;
  /** The workflow file the run belongs to, under the repository: .github/workflows/contract.yml unless given. */
  workflow?: string;
  /** The pull request the run is for, as a run of a pull_request workflow is; a push to main unless given. */
  pullRequest?: number;
  /**
   * The run's workflow with the ref it ran from, as job_workflow_ref names it,
   * in place of the pair the workflow and the pull request make; its ref is
   * then the token's `ref`.
   */
  jobWorkflowRef?: string | undefined;
}

export interface ActionsOidc {
  /** The issuer's public keys, as GitHub publishes them at /.well-known/jwks. */
  readonly jwks: { keys: Record<string, unknown>[] };
  /**
   * A token for a run, signed by the issuer's key, or by a key the set does
   * not hold; issued at `now`, the clock's time unless given, and valid for 5
   * minutes, as GitHub's are. `claims` replaces any claim, and a claim given
   * as undefined is left out.
   */
  token(run: ActionsRun, options?: { claims?: Partial<Record<keyof ActionsClaims | string, unknown>>; now?: Date; signedBy?: "issuer" | "another key" }): string;
}

/** The test issuer of GitHub Actions OIDC tokens, with its key pair and the key id its set names it by. */
export function createActionsOidc(): ActionsOidc {
  const issuer = keyPair();
  const another = keyPair();
  const kid = randomUUID();
  const publicJwk = issuer.publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  return {
    jwks: { keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] },
    token(run, options = {}) {
      const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
      const [owner = ""] = run.repository.split("/");
      // GitHub's pair: a push runs the workflow from the branch, a pull request's run from the pull request's merge ref.
      const pull = run.pullRequest;
      const jobWorkflowRef =
        run.jobWorkflowRef ?? `${run.repository}/${run.workflow ?? ".github/workflows/contract.yml"}@${pull === undefined ? "refs/heads/main" : `refs/pull/${pull}/merge`}`;
      const at = jobWorkflowRef.indexOf("@refs/");
      const ref = jobWorkflowRef.slice((at === -1 ? jobWorkflowRef.lastIndexOf("@") : at) + 1);
      const claims: Record<string, unknown> = {
        iss: GITHUB_ACTIONS_ISSUER,
        aud: run.audience,
        sub: pull === undefined ? `repo:${run.repository}:ref:${ref}` : `repo:${run.repository}:pull_request`,
        jti: randomUUID(),
        iat: now,
        nbf: now - 300,
        exp: now + 300,
        repository: run.repository,
        repository_id: String(run.repositoryId),
        repository_owner: owner,
        repository_owner_id: String(run.repositoryOwnerId),
        job_workflow_ref: jobWorkflowRef,
        workflow_ref: jobWorkflowRef,
        ref,
        sha: "c".repeat(40),
        event_name: pull === undefined ? "push" : "pull_request",
        run_id: "9100200300",
      };
      for (const [name, value] of Object.entries(options.claims ?? {})) {
        if (value === undefined) delete claims[name];
        else claims[name] = value;
      }
      return sign({ alg: "RS256", kid, typ: "JWT" }, claims, (options.signedBy === "another key" ? another : issuer).privateKey);
    },
  };
}

function keyPair(): { publicKey: KeyObject; privateKey: KeyObject } {
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
}

/** A JWS in compact form: the header and the claims, base64url-encoded, signed with RSA and SHA-256. */
function sign(header: Record<string, unknown>, claims: Record<string, unknown>, key: KeyObject): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${encode(header)}.${encode(claims)}`;
  const signature = createSign("RSA-SHA256").update(input).sign(key).toString("base64url");
  return `${input}.${signature}`;
}
