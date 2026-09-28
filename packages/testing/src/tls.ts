import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { isIPv4 } from "node:net";

// A self-signed TLS certificate for tests that must serve HTTPS, such as the
// setup screen of an install whose URL is not a trial URL: its setup session
// lives in a `__Host-` cookie, which a browser keeps only over HTTPS. The
// certificate is made here, with Node's own crypto, so no test depends on a
// certificate tool being installed. Its key is fresh for every call and never
// leaves the test.
//
// A browser trusts it when it is started with
// `--ignore-certificate-errors-spki-list=<spkiSha256>`: Chrome then accepts a
// certificate whose public key has that SHA-256, and no other.

export interface TestCertificate {
  /** The private key, as PEM. */
  key: string;
  /** The certificate, as PEM. */
  cert: string;
  /** The SHA-256 of the certificate's SubjectPublicKeyInfo, in base64, as Chrome's SPKI list takes it. */
  spkiSha256: string;
}

export interface TestCertificateOptions {
  /** The host names the certificate is for. */
  dnsNames?: readonly string[];
  /** The IPv4 addresses the certificate is for. */
  ipAddresses?: readonly string[];
  /** How many days from now it stays valid: 30 unless given. */
  days?: number;
}

/** A self-signed certificate on a fresh P-256 key, for the given names and addresses. */
export function createTestCertificate(options: TestCertificateOptions = {}): TestCertificate {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const now = Date.now();
  const name = sequence(set(sequence(oid("2.5.4.3"), utf8String("Tiehall test certificate"))));
  const altNames = [
    ...(options.dnsNames ?? []).map((host) => tagged(0x82, Buffer.from(host, "ascii"))),
    ...(options.ipAddresses ?? []).map((address) => {
      if (!isIPv4(address)) throw new Error(`not an IPv4 address: ${address}`);
      return tagged(0x87, Buffer.from(address.split(".").map(Number)));
    }),
  ];
  const extensions = [
    // subjectAltName
    sequence(oid("2.5.29.17"), octetString(sequence(...altNames))),
    // basicConstraints: not a CA, critical
    sequence(oid("2.5.29.19"), boolean(true), octetString(sequence())),
    // extKeyUsage: serverAuth
    sequence(oid("2.5.29.37"), octetString(sequence(oid("1.3.6.1.5.5.7.3.1")))),
  ];
  const ecdsaWithSha256 = sequence(oid("1.2.840.10045.4.3.2"));
  const tbs = sequence(
    tagged(0xa0, integer(Buffer.from([2]))),
    integer(Buffer.concat([Buffer.from([0x01]), randomBytes(15)])),
    ecdsaWithSha256,
    name,
    sequence(utcTime(new Date(now - 24 * 60 * 60 * 1000)), utcTime(new Date(now + (options.days ?? 30) * 24 * 60 * 60 * 1000))),
    name,
    spki,
    tagged(0xa3, sequence(...extensions)),
  );
  const signature = sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" });
  const certificate = sequence(tbs, ecdsaWithSha256, bitString(signature));
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    cert: pem("CERTIFICATE", certificate),
    spkiSha256: createHash("sha256").update(spki).digest("base64"),
  };
}

// DER, as X.509 needs it: each value is its tag, its length and its content.

function tagged(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(content.length), content]);
}

function length(size: number): Buffer {
  if (size < 0x80) return Buffer.from([size]);
  const bytes: number[] = [];
  for (let rest = size; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function sequence(...items: Buffer[]): Buffer {
  return tagged(0x30, Buffer.concat(items));
}

function set(...items: Buffer[]): Buffer {
  return tagged(0x31, Buffer.concat(items));
}

/** A non-negative INTEGER from its big-endian bytes. */
function integer(bytes: Buffer): Buffer {
  return tagged(0x02, (bytes[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
}

function boolean(value: boolean): Buffer {
  return tagged(0x01, Buffer.from([value ? 0xff : 0]));
}

function octetString(content: Buffer): Buffer {
  return tagged(0x04, content);
}

function bitString(content: Buffer): Buffer {
  return tagged(0x03, Buffer.concat([Buffer.from([0]), content]));
}

function utf8String(text: string): Buffer {
  return tagged(0x0c, Buffer.from(text, "utf8"));
}

/** UTCTime, YYMMDDHHMMSSZ, which covers the years 1950 to 2049. */
function utcTime(date: Date): Buffer {
  const text = date.toISOString().replace(/[-:T]/g, "").slice(2, 14);
  return tagged(0x17, Buffer.from(`${text}Z`, "ascii"));
}

function oid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const groups: number[] = [];
    for (let value = arc; ; value = Math.floor(value / 128)) {
      groups.unshift(value % 128);
      if (value < 128) break;
    }
    bytes.push(...groups.map((group, index) => (index < groups.length - 1 ? group | 0x80 : group)));
  }
  return tagged(0x06, Buffer.from(bytes));
}

function pem(label: string, der: Buffer): string {
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}
