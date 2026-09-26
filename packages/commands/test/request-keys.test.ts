import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Refusal } from "@tiehall/core";
import { resolveRequestKey, withOrg, type WebSessionCaller } from "../src/index.ts";
import { startTestInstall, type TestInstall } from "./support/install.ts";
import { addUser } from "./support/members.ts";

// Request keys that use a renamed team key keep resolving (requests: Request
// keys that use a renamed team key keep resolving; requests: Per-team request
// keys; teams-and-roles: Team keys; design.md, Design rules: Teams and roles).
// A key names its request through the team's current key or any key the team
// had before a rename, which stays its alias; the request's own key is always
// the one with the team's current key. A key that names no request of the
// install is a record that does not exist, which the error model answers with
// 404.

let install: TestInstall;
let ada: WebSessionCaller;
let feId: string;
let beId: string;
let fe142: string;

beforeAll(async () => {
  install = await startTestInstall();
  ada = { kind: "web_session", userId: await addUser(install.owner, { role: "admin", login: "ada" }), sessionId: randomUUID() };
  const alice = await addUser(install.owner, { login: "alice" });
  const team = async (key: string) =>
    (await install.owner.query<{ id: string }>("INSERT INTO teams (org_id, key, name) SELECT id, $1, $1 FROM orgs RETURNING id", [key]))
      .rows[0]?.id ?? "";
  feId = await team("FE");
  beId = await team("BE");
  fe142 =
    (
      await install.owner.query<{ id: string }>(
        `INSERT INTO requests (org_id, target_team_id, number, title, requesting_user_id, requesting_team_id)
         SELECT id, $1, 142, 'Add a dark mode', $2, $3 FROM orgs RETURNING id`,
        [feId, alice, beId],
      )
    ).rows[0]?.id ?? "";
});

afterAll(async () => {
  await install.close();
});

function resolve(key: string) {
  return withOrg(install.db, (context) => resolveRequestKey(context, key));
}

async function changeKey(teamId: string, key: string): Promise<void> {
  const result = await install.web(ada).write("teams.change_key", { teamId, key }, install.fromThePage(ada));
  if (!result.ok) throw new Error(`teams.change_key failed: ${JSON.stringify(result.problem)}`);
}

describe("a request key", () => {
  it("names the request through its team's current key", async () => {
    expect(await resolve("FE-142")).toEqual({ requestId: fe142, key: "FE-142" });
  });

  it("still names the same request after its team's key is renamed, and the request's key follows the new one", async () => {
    await changeKey(feId, "WEB");
    expect(await resolve("FE-142")).toEqual({ requestId: fe142, key: "WEB-142" });
    expect(await resolve("WEB-142")).toEqual({ requestId: fe142, key: "WEB-142" });
  });

  it("keeps resolving through every key the team had, after a second rename", async () => {
    await changeKey(feId, "FRONT");
    for (const key of ["FE-142", "WEB-142", "FRONT-142"]) expect(await resolve(key), key).toEqual({ requestId: fe142, key: "FRONT-142" });
  });

  it.each([
    ["a number the team never gave", "FRONT-999"],
    ["a team the install does not have", "ZZ-1"],
    ["another team's key with the number", "BE-142"],
    ["a number past what a key can hold", "FRONT-99999999999"],
  ])("gets 404 for %s", async (_name, key) => {
    const refusal = await resolve(key).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(Refusal);
    expect(refusal).toMatchObject({ reason: "record-not-found", status: 404 });
  });
});
