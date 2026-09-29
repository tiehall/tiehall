import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createGitHubClient } from "../src/github-client.ts";
import { organizationMemberIds, organizationMembership, type OrganizationInstallation } from "../src/github-organizations.ts";

// What GitHub reports of an organization's members (sign-in: Who may sign in;
// sign-in: Leaving the GitHub organization ends access; design.md,
// Self-hosting decisions: S5). GitHub documents that the member endpoints
// serve only public members to a requester that may not see the
// organization's members: `GET /orgs/{org}/members/{username}` answers such a
// requester 302, to `/orgs/{org}/public_members/{username}`, which answers 204
// for a public member and 404 for anyone else, and `GET /orgs/{org}/members`
// lists the public members only, with 200. An installation's token is such a
// requester when GitHub issued it without the Members permission, as after an
// owner removes that permission, and for an organization that is not the
// installation's own, as when another organization took the login of the
// installation's organization after a rename. None of those answers is a
// report of the installation's organization. The server below answers as
// GitHub documents; the GitHub stub refuses such calls with 403 instead.

/** The installation's organization, as the server's GitHub knows it: acme, by its account's id. */
const ACME_ID = 7;
const MEMBERS = [
  { login: "omar", id: 101, public: true },
  { login: "ana", id: 102, public: false },
];
/** mallory is a public member of the organization that took acme's login, in the second world below. */
const OTHER_MEMBERS = [{ login: "mallory", id: 900, public: true }];

/** What the server's GitHub is like for the next calls. */
let world: {
  /** The permissions GitHub issues the installation's token with. */
  permissions: Record<string, string>;
  /** The id of the organization that holds the login acme now. */
  acmeIsNow: number;
  /** GitHub answers the membership check with 302 whatever the requester may see. */
  alwaysRedirects: boolean;
};

let server: Server;
let apiUrl: string;

function send(response: import("node:http").ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, body === undefined ? headers : { "content-type": "application/json", ...headers });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const members = world.acmeIsNow === ACME_ID ? MEMBERS : OTHER_MEMBERS;
    // The token may see acme's members only with the Members permission, and only while acme is its organization.
    const seesMembers = world.acmeIsNow === ACME_ID && (world.permissions["members"] === "read" || world.permissions["members"] === "write");
    if (request.method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)) {
      send(response, 201, { token: "ghs_organizations", expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: world.permissions });
      return;
    }
    if (request.method === "GET" && url.pathname === "/users/acme") {
      send(response, 200, { login: "acme", id: world.acmeIsNow, type: "Organization" });
      return;
    }
    const check = /^\/orgs\/acme\/members\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && check) {
      if (!seesMembers || world.alwaysRedirects) {
        send(response, 302, undefined, { location: `${apiUrl}/orgs/acme/public_members/${check[1]}` });
        return;
      }
      send(response, members.some(({ login }) => login === check[1]) ? 204 : 404, members.some(({ login }) => login === check[1]) ? undefined : { message: "Not Found" });
      return;
    }
    const publicCheck = /^\/orgs\/acme\/public_members\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && publicCheck) {
      const isPublic = members.some(({ login, public: shown }) => login === publicCheck[1] && shown);
      send(response, isPublic ? 204 : 404, isPublic ? undefined : { message: "Not Found" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/orgs/acme/members") {
      send(
        response,
        200,
        members.filter(({ public: shown }) => seesMembers || shown).map(({ login, id }) => ({ login, id, type: "User" })),
      );
      return;
    }
    send(response, 404, { message: "Not Found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  world = { permissions: { members: "read", metadata: "read" }, acmeIsNow: ACME_ID, alwaysRedirects: false };
});

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const installation: OrganizationInstallation = { id: "installation", installationId: 42, organizationId: ACME_ID, organizationLogin: "acme" };

/** A new client, so no token or answer from an earlier test is remembered. */
function client() {
  return createGitHubClient({ clientId: "Iv1.organizations", privateKey }, { apiUrl });
}

describe("asked through a token with the Members permission, about the installation's own organization", () => {
  it("reports a member, a person who is not one, and the whole member list, private members included", async () => {
    expect(await organizationMembership(client(), installation, "ana")).toBe("member");
    expect(await organizationMembership(client(), installation, "lee")).toBe("not_member");
    expect([...(await organizationMemberIds(client(), installation))].sort()).toEqual([101, 102]);
  });

  it("does not follow a redirect of the membership check, which GitHub answers a requester that may not see the members", async () => {
    world.alwaysRedirects = true;
    expect(await organizationMembership(client(), installation, "omar")).toBe("unknown");
  });
});

describe("asked through a token GitHub issued without the Members permission", () => {
  beforeEach(() => {
    world.permissions = { metadata: "read" };
  });

  it("gives no report of a public member, whom GitHub shows anyone", async () => {
    expect(await organizationMembership(client(), installation, "omar")).toBe("unknown");
  });

  it("gives no report that a private member is not one", async () => {
    expect(await organizationMembership(client(), installation, "ana")).toBe("unknown");
  });

  it("gives no member list, since GitHub lists the public members only", async () => {
    await expect(organizationMemberIds(client(), installation)).rejects.toThrow();
  });
});

describe("asked by a login that another organization took after the installation's organization was renamed", () => {
  beforeEach(() => {
    world.acmeIsNow = 555;
  });

  it("gives no report that a public member of that other organization is a member", async () => {
    expect(await organizationMembership(client(), installation, "mallory")).toBe("unknown");
  });

  it("gives no report that a member of the installation's organization is not one", async () => {
    expect(await organizationMembership(client(), installation, "ana")).toBe("unknown");
  });

  it("gives no member list, since GitHub lists that other organization's public members", async () => {
    await expect(organizationMemberIds(client(), installation)).rejects.toThrow();
  });
});
