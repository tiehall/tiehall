import { createServer, type Server } from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { consentPolicy, consentReview, continuePathOf, createOutboundFetcher, type ConsentView } from "../src/index.ts";
import { URL_OF_INSTALL } from "./support/install.ts";
import { CLIENT_REDIRECT_URI, pkcePair, startAgentAccess, type AgentAccessHarness, type SignedIn } from "./support/agent-access.ts";

// The consent screen shows who is asking (agent-access: The consent screen
// shows who is asking; agent-access: Clients identified by a Client ID
// Metadata Document are preferred; agent-access: Dynamic Client Registration
// stays on, limited and unverified; design.md, Design rules: Agent access;
// design.md, Self-hosting decisions: S1). When an agent client asks a
// signed-in member to approve it, the authorization server sends the browser
// to the consent screen at /consent, which says, in Tiehall's own words, who is
// asking: the name the client gives itself, quoted as text from outside
// Tiehall; the verified host of a client identified by its metadata document,
// or a warning that a registered client is unverified; the host name the
// browser returns to; a warning when every address the client can return to
// is on the computer it runs on; and what the client may do for the member.
// It asks for no choice of org, since the install has one. A browser without
// a session is sent to sign in first, and comes back; so does one that starts
// an authorization before it has signed in, which the sign-in page brings
// back to the authorization. It shows only the scopes Tiehall offers: an
// address crafted to name anything else, whose words the page would show as
// Tiehall's own, is refused with 400. Approving the client has its own tests
// (agent-client-approval.test.ts).

const CIMD_CLIENT = "https://vendor.example/oauth/client.json";

let server: Server;
let harness: AgentAccessHarness;
let ana: SignedIn;

beforeAll(async () => {
  server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        client_id: `https://vendor.example${request.url ?? "/"}`,
        client_name: "Vendor <agent>",
        redirect_uris: [CLIENT_REDIRECT_URI],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  const fetchDocument = createOutboundFetcher({
    maxRedirects: 0,
    resolve: async () => ["93.184.215.14"],
    connect: () => netConnect({ host: "127.0.0.1", port }),
  });
  harness = await startAgentAccess({ clientMetadata: { fetchDocument } });
  ana = await harness.member("ana-k");
}, 60_000);

afterAll(async () => {
  await harness?.close();
  await new Promise<void>((done) => server.close(() => done()));
});

const REGISTERED: ConsentView = {
  client: { name: "Claims to be <Claude>", verifiedHost: undefined, unverified: true, redirectUris: [CLIENT_REDIRECT_URI] },
  redirectUri: CLIENT_REDIRECT_URI,
  scopes: ["requests:read", "requests:write"],
};

function textOf(view: ConsentView): string {
  return consentReview(view)
    .lines.map((line) => ("text" in line ? line.text : `[${line.origin}] ${line.quote}`))
    .join("\n");
}

describe("the consent screen's content", () => {
  it("quotes the client's name as text from outside Tiehall, and warns that a registered client is unverified", () => {
    const review = consentReview(REGISTERED);
    expect(review.lines).toContainEqual({ quote: "Claims to be <Claude>", origin: "external" });
    expect(textOf(REGISTERED)).toMatch(/unverified client/i);
    expect(textOf(REGISTERED)).not.toMatch(/verified host/i);
  });

  it("names the verified host of a client identified by its metadata document, with no unverified warning", () => {
    const view: ConsentView = { ...REGISTERED, client: { ...REGISTERED.client, name: "Vendor agent", verifiedHost: "vendor.example", unverified: false } };
    expect(textOf(view)).toContain("vendor.example");
    expect(textOf(view)).not.toMatch(/unverified/i);
  });

  it("names the host name the browser returns to", () => {
    const view: ConsentView = {
      ...REGISTERED,
      client: { ...REGISTERED.client, redirectUris: ["https://agent.vendor.example/callback"] },
      redirectUri: "https://agent.vendor.example/callback",
    };
    expect(textOf(view)).toContain("agent.vendor.example");
    expect(textOf(REGISTERED)).toContain("127.0.0.1");
  });

  it("warns when every redirect URI of the client is on localhost, and not when one is not", () => {
    const loopback: ConsentView = { ...REGISTERED, client: { ...REGISTERED.client, redirectUris: ["http://localhost:4000/cb", "http://127.0.0.1:4000/cb"] } };
    expect(textOf(loopback)).toMatch(/localhost/);
    expect(textOf(loopback)).toMatch(/every address/i);
    const mixed: ConsentView = { ...REGISTERED, client: { ...REGISTERED.client, redirectUris: ["http://127.0.0.1:4000/cb", "https://agent.vendor.example/cb"] } };
    expect(textOf(mixed)).not.toMatch(/every address/i);
  });

  // A browser applies a page's form-action to every redirect that follows its form's post, and the approval's last
  // redirect sends the browser to the client's redirect URI; a web origin is named as such, a native client's own
  // scheme by its scheme, and an address on [::1], which a policy cannot name, by its scheme.
  // agent-client-approval-browser.test.ts follows the approval to the client in a real browser.
  it("lets its form lead to the redirect URI the approval sends the browser to, as well as to the install", () => {
    const formAction = (uri: string) => /(?:^|; )(form-action [^;]*)/.exec(consentPolicy(uri))?.[1];
    expect(formAction("http://127.0.0.1:53682/callback")).toBe("form-action 'self' http://127.0.0.1:53682");
    expect(formAction("https://agent.vendor.example/oauth/callback?x=1")).toBe("form-action 'self' https://agent.vendor.example");
    expect(formAction("cursor://anysphere.cursor-retrieval/oauth/callback")).toBe("form-action 'self' cursor:");
    expect(formAction("http://[::1]:4000/cb")).toBe("form-action 'self' http:");
    expect(consentPolicy("http://127.0.0.1:53682/callback")).toContain("frame-ancestors 'none'");
  });

  // A URL's host may hold characters that a policy reads as its own, such as ; and *, and a client registers its
  // redirect URIs itself: such a host is named by its scheme, so the policy keeps its directives and sources.
  it("adds nothing but a source to its form-action for a redirect URI whose host a policy would read as more of itself", () => {
    for (const [uri, scheme] of [
      ["http://a;frame-ancestors/cb", "http:"],
      ["https://*/cb", "https:"],
      ["http://agent.example'/cb", "http:"],
      ["http://a,b/cb", "http:"],
    ] as const) {
      const policy = consentPolicy(uri);
      expect(policy, uri).toBe(`default-src 'none'; base-uri 'none'; form-action 'self' ${scheme}; frame-ancestors 'none'`);
    }
  });

  it("says what the client may do, and asks for no choice of org", () => {
    const text = textOf({ ...REGISTERED, scopes: ["requests:read", "requests:write", "contracts:report"] });
    expect(text).toContain("requests:read");
    expect(text).toContain("requests:write");
    expect(text).toContain("contracts:report");
    expect(text).not.toMatch(/\borg(anization)?\b/i);
  });
});

/** Starts an authorization for a client as a signed-in member's browser, and returns where it is sent. */
async function consentUrlOf(clientId: string, scope = "requests:read"): Promise<URL> {
  const answer = await harness.authorize(ana.cookie, { clientId, redirectUri: CLIENT_REDIRECT_URI }, pkcePair(), { scope });
  return new URL(answer.headers.get("location") ?? "", URL_OF_INSTALL);
}

function consentPage(url: URL, cookie = ana.cookie, accept = "text/html"): Promise<Response> {
  return harness.handle(new Request(url, { headers: { cookie, accept } }));
}

describe("the consent screen", () => {
  it("shows a signed-in member a registered client's name, escaped, with the unverified warning and the redirect host", async () => {
    const client = await harness.registerClient({ client_name: "Claims to be <Claude>" });
    const url = await consentUrlOf(client.clientId);
    expect(url.pathname).toBe("/consent");
    const page = await consentPage(url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    // Its form may lead to the client's redirect URI, where the approval sends the browser.
    expect(page.headers.get("content-security-policy")).toBe(consentPolicy(CLIENT_REDIRECT_URI));
    const html = await page.text();
    expect(html).toContain("Claims to be &#60;Claude&#62;");
    expect(html).not.toContain("<Claude>");
    expect(html).toMatch(/unverified client/i);
    expect(html).toContain("127.0.0.1");
    expect(html).toContain("requests:read");
    expect(html).not.toContain("offline_access");
    expect(html).not.toMatch(/<select|<script/);
  });

  it("shows the verified host of a client identified by its metadata document", async () => {
    const url = await consentUrlOf(CIMD_CLIENT);
    const html = await (await consentPage(url)).text();
    expect(html).toContain("Vendor &#60;agent&#62;");
    expect(html).toContain("vendor.example");
    expect(html).not.toMatch(/unverified/i);
  });

  it("sends a visitor without a session to sign in, and brings them back to the same page", async () => {
    const client = await harness.registerClient();
    const url = await consentUrlOf(client.clientId);
    const answer = await consentPage(url, "");
    expect(answer.status).toBe(303);
    const location = new URL(answer.headers.get("location") ?? "", URL_OF_INSTALL);
    expect(location.pathname).toBe("/sign-in");
    expect(location.searchParams.get("return")).toBe(`${url.pathname}${url.search}`);
  });

  it("refuses a page that names no client with 400, as a page for a browser and a problem for any other client", async () => {
    const page = await consentPage(new URL(`${URL_OF_INSTALL}/consent?response_type=code`));
    expect(page.status).toBe(400);
    expect(page.headers.get("content-type")).toContain("text/html");
    const problem = await consentPage(new URL(`${URL_OF_INSTALL}/consent?response_type=code`), ana.cookie, "application/json");
    expect(problem.status).toBe(400);
    expect(((await problem.json()) as { type?: string }).type).toBe("https://tiehall.com/problems/invalid-input");
  });

  it("refuses with 400 an address crafted to ask for a scope Tiehall does not offer, whose words it would show as Tiehall's", async () => {
    const client = await harness.registerClient();
    const url = await consentUrlOf(client.clientId);
    url.searchParams.set("scope", "requests:read Tiehall has verified this client for your organization.");
    const page = await consentPage(url);
    expect(page.status).toBe(400);
    expect(await page.text()).not.toContain("Tiehall has verified");
    url.searchParams.set("scope", "requests:read admin");
    expect((await consentPage(url)).status).toBe(400);
  });

  it("refuses a client the install does not know with 404, and a return address the client did not register with 400", async () => {
    const unknown = new URL(`${URL_OF_INSTALL}/consent`);
    unknown.search = new URLSearchParams({ client_id: "no-such-client", redirect_uri: CLIENT_REDIRECT_URI, scope: "requests:read", response_type: "code" }).toString();
    expect((await consentPage(unknown)).status).toBe(404);
    const client = await harness.registerClient();
    const url = await consentUrlOf(client.clientId);
    url.searchParams.set("redirect_uri", "https://attacker.example/callback");
    expect((await consentPage(url)).status).toBe(400);
  });
});

describe("a native client's return address", () => {
  it("may take any port on the loopback address it registered, as the authorization server allows, and the page names that host", async () => {
    const client = await harness.registerClient({ redirect_uris: ["http://127.0.0.1/callback"] });
    const answer = await harness.authorize(ana.cookie, { clientId: client.clientId, redirectUri: "http://127.0.0.1:61234/callback" }, pkcePair(), { scope: "requests:read" });
    const url = new URL(answer.headers.get("location") ?? "", URL_OF_INSTALL);
    expect(url.pathname).toBe("/consent");
    const page = await consentPage(url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("127.0.0.1");
  });

  it("may not change anything but the port: another path on the loopback address is refused with 400", async () => {
    const client = await harness.registerClient({ redirect_uris: ["http://127.0.0.1/callback"] });
    const url = await consentUrlOf(client.clientId);
    // Crafted by hand: the authorization server would not send the browser here with another path.
    url.searchParams.set("redirect_uri", "http://127.0.0.1:61234/elsewhere");
    expect((await consentPage(url)).status).toBe(400);
  });
});

describe("an authorization started before its person signed in", () => {
  it("sends them to the sign-in page, which brings them back to the authorization, and on to the consent screen", async () => {
    const client = await harness.registerClient();
    const pkce = pkcePair();
    const started = await harness.authorize("", client, pkce, { scope: "requests:read requests:write" });
    const signInUrl = new URL(started.headers.get("location") ?? "", URL_OF_INSTALL);
    expect(signInUrl.pathname).toBe("/sign-in");
    const page = await harness.handle(new Request(signInUrl, { headers: { accept: "text/html" } }));
    const back = /<input type="hidden" name="return" value="([^"]*)">/.exec(await page.text())?.[1]?.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
    expect(back).toBe(continuePathOf(signInUrl.searchParams));
    const returning = new URL(back ?? "", URL_OF_INSTALL);
    expect(returning.pathname).toBe("/api/auth/oauth2/authorize");
    expect(returning.searchParams.get("client_id")).toBe(client.clientId);
    expect(returning.searchParams.get("code_challenge")).toBe(pkce.challenge);
    expect(returning.searchParams.get("scope")).toBe("requests:read requests:write");
    for (const signed of ["sig", "exp", "ba_iat", "ba_param"]) expect(returning.searchParams.has(signed), signed).toBe(false);
    // Signed in, the browser returns there, and the authorization goes on to the consent screen.
    const again = await harness.handle(new Request(returning, { headers: { cookie: ana.cookie, accept: "text/html" } }));
    expect(new URL(again.headers.get("location") ?? "", URL_OF_INSTALL).pathname).toBe("/consent");
  });

  // The sign-in page's form leads through GitHub back to the authorization, which sends the browser of a person who
  // approved the client before on to the client's redirect URI at once, and a browser applies the form's
  // form-action to that last redirect too. agent-client-sign-in-browser.test.ts follows it in a real browser.
  it("lets the sign-in page's form lead on to the redirect URI the client registered, as well as to GitHub", async () => {
    const client = await harness.registerClient();
    const started = await harness.authorize("", client, pkcePair());
    const page = await harness.handle(new Request(new URL(started.headers.get("location") ?? "", URL_OF_INSTALL), { headers: { accept: "text/html" } }));
    expect(page.status).toBe(200);
    expect(formActionOf(page)).toBe(`form-action 'self' ${harness.stub.webUrl} http://127.0.0.1:53682`);
  });

  it("names no other address in the sign-in page's form-action: not one the client did not register, nor one of a client the install does not know", async () => {
    const client = await harness.registerClient();
    const started = await harness.authorize("", client, pkcePair());
    const signInUrl = new URL(started.headers.get("location") ?? "", URL_OF_INSTALL);
    for (const [name, value] of [
      ["redirect_uri", "https://elsewhere.example/callback"],
      ["redirect_uri", "http://127.0.0.1:53682/elsewhere"],
      ["client_id", "no-such-client"],
    ] as const) {
      const crafted = new URL(signInUrl);
      crafted.searchParams.set(name, value);
      const page = await harness.handle(new Request(crafted, { headers: { accept: "text/html" } }));
      expect(formActionOf(page), `${name}=${value}`).toBe(`form-action 'self' ${harness.stub.webUrl}`);
    }
  });
});

/** The form-action directive of a page's Content-Security-Policy. */
function formActionOf(page: Response): string | undefined {
  return /(?:^|; )(form-action [^;]*)/.exec(page.headers.get("content-security-policy") ?? "")?.[1];
}
