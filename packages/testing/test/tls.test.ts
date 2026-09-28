import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import { createServer, get } from "node:https";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createTestCertificate } from "../src/tls.ts";

// The self-signed certificate that tests serve HTTPS with, made without any
// certificate tool (design.md, Technical decisions: T17).

describe("a test certificate", () => {
  const made = createTestCertificate({ dnsNames: ["tiehall.example.com"], ipAddresses: ["127.0.0.1"] });
  const certificate = new X509Certificate(made.cert);

  it("is a valid X.509 certificate for its names and addresses, signed by its own key", () => {
    expect(certificate.checkHost("tiehall.example.com")).toBe("tiehall.example.com");
    expect(certificate.checkHost("github.com")).toBeUndefined();
    expect(certificate.checkIP("127.0.0.1")).toBe("127.0.0.1");
    expect(certificate.checkPrivateKey(createPrivateKey(made.key))).toBe(true);
    expect(certificate.verify(certificate.publicKey)).toBe(true);
    expect(certificate.ca).toBe(false);
    expect(new Date(certificate.validFrom).getTime()).toBeLessThan(Date.now());
    expect(new Date(certificate.validTo).getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);
  });

  it("names the SHA-256 of its public key as Chrome's SPKI list takes it", () => {
    const spki = certificate.publicKey.export({ type: "spki", format: "der" });
    expect(made.spkiSha256).toBe(createHash("sha256").update(spki).digest("base64"));
  });

  it("is fresh on every call", () => {
    expect(createTestCertificate().spkiSha256).not.toBe(made.spkiSha256);
  });

  it("serves HTTPS to a client that trusts it", async () => {
    const server = createServer({ key: made.key, cert: made.cert }, (_request, response) => response.end("up"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const body = await new Promise<string>((resolve, reject) => {
        get({ host: "127.0.0.1", port, path: "/", ca: made.cert, servername: "tiehall.example.com" }, (response) => {
          let text = "";
          response.on("data", (chunk: Buffer) => (text += chunk.toString()));
          response.on("end", () => resolve(text));
        }).on("error", reject);
      });
      expect(body).toBe("up");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
