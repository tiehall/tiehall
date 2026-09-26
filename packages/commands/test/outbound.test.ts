import { createServer, type Server } from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";
import { Refusal } from "@tiehall/core";
import { jiraSiteUrl } from "@tiehall/catalog";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createGitHubFetch,
  createJiraFetch,
  createOutboundFetcher,
  isPublicAddress,
  OutboundRefused,
  type ConnectTarget,
} from "../src/outbound.ts";

// Outbound fetches refuse internal addresses (agent-safety: Outbound fetches
// refuse internal addresses; design.md, Technical decisions: T14; design.md,
// Self-hosting decisions: S8). The fetcher for Client ID Metadata Documents,
// the only content Tiehall fetches from an address a caller names, resolves
// the host name itself, checks every address it resolves to, and connects only
// to the address it checked; it refuses loopback, private, link-local and
// cloud metadata addresses, and redirects to them. The tests name hosts
// through a resolver of their own and route the connections to a local server,
// recording each address the fetcher connects to. GitHub calls go only to
// GitHub's hosts, and Jira calls only to a site of the form
// https://<name>.atlassian.net, whose URL is refused as invalid input
// otherwise, before any call.

const HOSTS: Readonly<Record<string, string[]>> = {
  "client.example": ["93.184.215.14"],
  "other.example": ["2606:2800:21f:cb07:6820:80da:af6b:8b2c"],
  "loopback.example": ["127.0.0.1"],
  "v6-loopback.example": ["::1"],
  "private.example": ["10.0.0.5"],
  "internal.example": ["192.168.1.10"],
  "metadata.example": ["169.254.169.254"],
  "mixed.example": ["93.184.215.14", "10.0.0.5"],
  "mapped.example": ["::ffff:127.0.0.1"],
  "unique-local.example": ["fd00:ec2::254"],
  "shared.example": ["100.100.100.200"],
};

let server: Server;
let port: number;
let connections: ConnectTarget[];
let resolved: string[];
let seenHosts: string[];

beforeAll(async () => {
  server = createServer((request, response) => {
    seenHosts.push(request.headers.host ?? "");
    const redirect = (location: string) => response.writeHead(302, { location }).end();
    switch (request.url) {
      case "/client.json":
        return response.writeHead(200, { "content-type": "application/json" }).end('{"client_id":"https://client.example/client.json"}');
      case "/to-private-http":
        return redirect("http://192.168.1.10/client.json");
      case "/to-private-https":
        return redirect("https://192.168.1.10/client.json");
      case "/to-internal-name":
        return redirect("https://internal.example/client.json");
      case "/to-metadata":
        return redirect("https://169.254.169.254/latest/meta-data/");
      case "/to-public":
        return redirect("https://other.example/client.json");
      case "/loop":
        return redirect("/loop");
      case "/big":
        return response.writeHead(200, { "content-type": "application/json" }).end(`"${"x".repeat(100_000)}"`);
      default:
        return response.writeHead(404).end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

beforeEach(() => {
  connections = [];
  resolved = [];
  seenHosts = [];
});

/** The fetcher, with the test's resolver and every connection routed to the local server. */
function fetcher(resolve?: (hostname: string) => Promise<string[]>) {
  return createOutboundFetcher({
    resolve:
      resolve ??
      (async (hostname) => {
        resolved.push(hostname);
        return HOSTS[hostname] ?? [];
      }),
    connect: (target) => {
      connections.push(target);
      return netConnect(port, "127.0.0.1");
    },
    maxBytes: 64 * 1024,
  });
}

async function refusal(promise: Promise<unknown>): Promise<OutboundRefused> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(OutboundRefused);
  return error as OutboundRefused;
}

describe("the fetcher for Client ID Metadata Documents", () => {
  it("fetches a document from a public address, connecting only to the address it checked", async () => {
    const document = await fetcher()("https://client.example/client.json");
    expect(document).toMatchObject({ status: 200, url: "https://client.example/client.json", body: '{"client_id":"https://client.example/client.json"}' });
    expect(connections).toEqual([{ address: "93.184.215.14", port: 443, hostname: "client.example", tls: true }]);
    expect(seenHosts).toEqual(["client.example"]);
  });

  it("resolves each host once and connects to that answer, whatever the name resolves to later", async () => {
    let calls = 0;
    const rebinding = async () => (calls++ === 0 ? ["93.184.215.14"] : ["127.0.0.1"]);
    await fetcher(rebinding)("https://client.example/client.json");
    expect(calls).toBe(1);
    expect(connections.map(({ address }) => address)).toEqual(["93.184.215.14"]);
  });

  it.each([
    ["a name that resolves to 127.0.0.1", "https://loopback.example/client.json"],
    ["a name that resolves to ::1", "https://v6-loopback.example/client.json"],
    ["127.0.0.1 itself", "https://127.0.0.1/client.json"],
    ["::1 itself", "https://[::1]/client.json"],
    ["127.0.0.1 written as a number", "https://2130706433/client.json"],
    ["localhost", "https://localhost/client.json"],
    ["a name that resolves to 10.0.0.5", "https://private.example/client.json"],
    ["a name that resolves to 169.254.169.254", "https://metadata.example/latest/meta-data/"],
    ["169.254.169.254 itself", "https://169.254.169.254/latest/meta-data/"],
    ["a name with a public and a private address", "https://mixed.example/client.json"],
    ["a name that resolves to 127.0.0.1 written as IPv6", "https://mapped.example/client.json"],
    ["a name that resolves to a unique local IPv6 address", "https://unique-local.example/client.json"],
    ["a name that resolves to the shared address space", "https://shared.example/client.json"],
    ["a name that resolves to nothing", "https://nowhere.example/client.json"],
  ])("refuses %s and connects to nothing", async (_, url) => {
    const refused = await refusal(fetcher(async (hostname) => (hostname === "localhost" ? ["127.0.0.1", "::1"] : (HOSTS[hostname] ?? [])))(url));
    expect(refused.reason).toBe("address");
    expect(connections).toEqual([]);
  });

  it.each([
    ["http://192.168.1.10/client.json", "/to-private-http"],
    ["https://192.168.1.10/client.json", "/to-private-https"],
    ["a name that resolves to 192.168.1.10", "/to-internal-name"],
    ["the metadata address", "/to-metadata"],
  ])("refuses a redirect to %s without following it", async (_, path) => {
    await refusal(fetcher()(`https://client.example${path}`));
    expect(connections.map(({ address }) => address)).toEqual(["93.184.215.14"]);
  });

  it("follows a redirect to another public address, checking it first", async () => {
    const document = await fetcher()("https://client.example/to-public");
    expect(document).toMatchObject({ status: 200, url: "https://other.example/client.json" });
    expect(resolved).toEqual(["client.example", "other.example"]);
    expect(connections.map(({ address }) => address)).toEqual(["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"]);
  });

  it("stops after three redirects", async () => {
    expect((await refusal(fetcher()("https://client.example/loop"))).reason).toBe("redirect");
    expect(connections).toHaveLength(4);
  });

  it("refuses anything but https, and a URL that carries credentials", async () => {
    for (const url of ["http://client.example/client.json", "ftp://client.example/client.json", "file:///etc/passwd", "https://user:secret@client.example/client.json"]) {
      expect((await refusal(fetcher()(url))).reason).toBe("url");
    }
    expect(connections).toEqual([]);
  });

  it("refuses localhost and a loopback address with the system's own resolver, before any connection", async () => {
    const system = createOutboundFetcher({ timeoutMs: 1_000 });
    for (const url of ["https://localhost/client.json", "https://127.0.0.1:1/client.json", "https://[::1]:1/client.json"]) {
      expect((await refusal(system(url))).reason).toBe("address");
    }
  });

  it("refuses a document larger than its limit", async () => {
    expect((await refusal(fetcher()("https://client.example/big"))).reason).toBe("size");
  });
});

describe("which addresses are public", () => {
  it.each([
    ["93.184.215.14", true],
    ["8.8.8.8", true],
    ["2606:2800:21f:cb07:6820:80da:af6b:8b2c", true],
    ["::ffff:8.8.8.8", true],
    ["0.0.0.0", false],
    ["127.0.0.1", false],
    ["127.255.255.254", false],
    ["10.0.0.5", false],
    ["172.16.0.1", false],
    ["172.31.255.255", false],
    ["192.168.1.10", false],
    ["169.254.169.254", false],
    ["100.64.0.1", false],
    ["100.100.100.200", false],
    ["192.0.0.192", false],
    ["198.18.0.1", false],
    ["224.0.0.1", false],
    ["255.255.255.255", false],
    ["::", false],
    ["::1", false],
    ["::ffff:127.0.0.1", false],
    ["::ffff:7f00:1", false],
    ["::ffff:169.254.169.254", false],
    ["64:ff9b::7f00:1", false],
    ["2002:7f00:1::", false],
    ["2001::1", false],
    ["2001:db8::1", false],
    ["fc00::1", false],
    ["fd00:ec2::254", false],
    ["fe80::1", false],
    ["ff02::1", false],
    ["not an address", false],
  ])("%s: %s", (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });
});

describe("calls to GitHub", () => {
  it("go only to GitHub's own hosts, over https", async () => {
    const called: string[] = [];
    const github = createGitHubFetch(async (input) => {
      called.push(String(input instanceof Request ? input.url : input));
      return new Response("{}");
    });
    await github("https://api.github.com/app/installations");
    await github(new URL("https://github.com/login/oauth/access_token"));
    await github(new Request("https://api.github.com/app-manifests/abc/conversions", { method: "POST" }));
    for (const url of [
      "http://api.github.com/app",
      "https://api.github.com.evil.example/app",
      "https://api.github.com:8443/app",
      "https://gist.github.com/",
      "https://10.0.0.5/app",
      "https://user@api.github.com/app",
    ]) {
      await expect(github(url)).rejects.toBeInstanceOf(OutboundRefused);
    }
    expect(called).toEqual([
      "https://api.github.com/app/installations",
      "https://github.com/login/oauth/access_token",
      "https://api.github.com/app-manifests/abc/conversions",
    ]);
  });
});

describe("calls to Jira", () => {
  it("take a site URL only of the form https://<name>.atlassian.net", () => {
    for (const site of ["https://acme.atlassian.net", "https://acme.atlassian.net/", "https://acme-eu2.atlassian.net"]) {
      expect(jiraSiteUrl.safeParse(site).success, site).toBe(true);
    }
    for (const site of [
      "https://jira.internal.example.com",
      "http://acme.atlassian.net",
      "https://acme.atlassian.net.evil.example",
      "https://a.b.atlassian.net",
      "https://atlassian.net",
      "https://acme.atlassian.net/jira",
      "https://user@acme.atlassian.net",
      "https://acme.atlassian.net:8443",
      "https://ACME.atlassian.net",
      "https://-acme.atlassian.net",
    ]) {
      expect(jiraSiteUrl.safeParse(site).success, site).toBe(false);
    }
  });

  it("refuse a site outside atlassian.net as invalid input and call nothing", () => {
    const called: string[] = [];
    let refused: unknown;
    try {
      createJiraFetch("https://jira.internal.example.com", async (input) => {
        called.push(String(input));
        return new Response("{}");
      });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(Refusal);
    expect((refused as Refusal).status).toBe(400);
    expect((refused as Refusal).reason).toBe("invalid-input");
    expect(called).toEqual([]);
  });

  it("go only to the connected site", async () => {
    const called: string[] = [];
    const jira = createJiraFetch("https://acme.atlassian.net/", async (input) => {
      called.push(String(input instanceof Request ? input.url : input));
      return new Response("{}");
    });
    await jira("https://acme.atlassian.net/rest/api/3/myself");
    for (const url of ["https://other.atlassian.net/rest/api/3/myself", "https://jira.internal.example.com/rest/api/3/myself", "http://acme.atlassian.net/rest"]) {
      await expect(jira(url)).rejects.toBeInstanceOf(OutboundRefused);
    }
    expect(called).toEqual(["https://acme.atlassian.net/rest/api/3/myself"]);
  });
});
