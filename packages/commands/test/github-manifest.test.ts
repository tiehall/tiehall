import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHubStub, type GitHubStub } from "@tiehall/testing/github";
import { buildAppManifest } from "../src/index.ts";

// The GitHub App's manifest, built from the install's URL
// (self-host-install: The GitHub App is created with GitHub's manifest flow;
// tracker-mirrors: The GitHub App asks for narrow permissions and every event
// up front; github-app-reachability: design.md, Design rules: The webhook and
// the install URL). GitHub refuses a webhook URL on localhost and events
// without a webhook, so a trial URL's App gets neither, and so does any App
// whose operator says GitHub cannot reach the install; every other App gets
// the active webhook at TIEHALL_URL/webhooks/github and the three events.
// No manifest lists the installation events, which every App receives anyway.

const PERMISSIONS = { metadata: "read", pull_requests: "read", issues: "write", members: "read", emails: "read" };

const WITHOUT_A_WEBHOOK = [
  { url: "http://localhost", unreachable: false },
  { url: "http://localhost:3000", unreachable: false },
  { url: "https://tiehall.example.com", unreachable: true },
];
const WITH_A_WEBHOOK = [
  { url: "https://tiehall.example.com", unreachable: false },
  { url: "https://tiehall.example.com:8443", unreachable: false },
];

describe("the manifest without a webhook", () => {
  for (const { url, unreachable } of WITHOUT_A_WEBHOOK) {
    it(`for ${url}${unreachable ? ", with the option that GitHub cannot reach it" : ""}, has no hook and no events`, () => {
      const manifest = buildAppManifest({ url, name: "Tiehall", unreachable });
      expect(manifest).not.toHaveProperty("hook_attributes");
      expect(manifest.default_events).toEqual([]);
    });
  }
});

describe("the manifest with a webhook", () => {
  for (const { url } of WITH_A_WEBHOOK) {
    it(`for ${url}, has the active hook at ${url}/webhooks/github and exactly the three events`, () => {
      const manifest = buildAppManifest({ url, name: "Tiehall", unreachable: false });
      expect(manifest.hook_attributes).toEqual({ url: `${url}/webhooks/github`, active: true });
      expect(manifest.default_events).toEqual(["pull_request", "issues", "organization"]);
    });
  }
});

describe("every manifest", () => {
  for (const { url, unreachable } of [...WITHOUT_A_WEBHOOK, ...WITH_A_WEBHOOK]) {
    it(`for ${url}${unreachable ? " with the option" : ""} asks for the five permissions, stays private and lists no installation event`, () => {
      const manifest = buildAppManifest({ url, name: "Tiehall Acme", unreachable });
      expect(manifest.default_permissions).toEqual(PERMISSIONS);
      expect(manifest.public).toBe(false);
      expect(manifest.default_events).not.toContain("installation");
      expect(manifest.default_events).not.toContain("installation_repositories");
      expect(manifest.name).toBe("Tiehall Acme");
      expect(manifest.url).toBe(url);
      for (const address of [manifest.redirect_url, ...manifest.callback_urls]) expect(new URL(address).origin).toBe(url);
      // The usual sign-in's callback, and the setup screen's, which completes setup while the setup gate serves only /setup.
      expect(manifest.callback_urls).toEqual([`${url}/api/auth/callback/github`, `${url}/setup/sign-in/callback/github`]);
    });
  }

  it("builds the same URLs, name and permissions with a webhook and without one", () => {
    const { hook_attributes: _, default_events: __, ...withHook } = buildAppManifest({ url: "https://tiehall.example.com", name: "Tiehall", unreachable: false });
    const { default_events: ___, ...withoutHook } = buildAppManifest({ url: "https://tiehall.example.com", name: "Tiehall", unreachable: true });
    expect(withoutHook).toEqual(withHook);
  });
});

describe("GitHub's answer", () => {
  let stub: GitHubStub;

  beforeAll(async () => {
    stub = await startGitHubStub();
    stub.addUser({ login: "omar" });
    stub.addOrg({ login: "acme", members: { omar: "admin" } });
    stub.signIn("omar");
  });

  afterAll(async () => {
    await stub.close();
  });

  it("accepts every manifest the builder makes, on a personal page and on an organization's", async () => {
    const cases = [...WITHOUT_A_WEBHOOK, ...WITH_A_WEBHOOK];
    for (const [index, { url, unreachable }] of cases.entries()) {
      for (const org of [undefined, "acme"]) {
        const manifest = buildAppManifest({ url, name: `Tiehall ${index} ${org ?? "personal"}`, unreachable });
        const outcome = await stub.createAppFromManifest({ manifest: { ...manifest }, ...(org === undefined ? {} : { org }), state: "state" });
        expect(outcome, `${url} ${unreachable ? "with" : "without"} the option, ${org ?? "personal"}`).toMatchObject({ status: "created" });
      }
    }
  });
});
