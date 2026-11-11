import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseOperatorCertificate } from "../src/webtransport-certificate.js";

function certificateFixture(
  commonName = "relay.example",
  subjectAltName = "DNS:relay.example,IP:127.0.0.1,IP:::1",
): { cert: string; key: string; otherKey: string } {
  const directory = mkdtempSync(join(process.env.WAFFLE_RELAY_TMPDIR ?? tmpdir(), "wt-cert-test-"));
  try {
    const cert = join(directory, "cert.pem");
    const key = join(directory, "key.pem");
    const otherKey = join(directory, "other-key.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-new",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "2",
        "-subj",
        `/CN=${commonName}`,
      ].concat(subjectAltName ? ["-addext", `subjectAltName=${subjectAltName}`] : [], [
        "-keyout",
        key,
        "-out",
        cert,
      ]),
      { stdio: "ignore" },
    );
    execFileSync("openssl", ["genrsa", "-out", otherKey, "2048"], { stdio: "ignore" });
    return {
      cert: readFileSync(cert, "utf8"),
      key: readFileSync(key, "utf8"),
      otherKey: readFileSync(otherKey, "utf8"),
    };
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

test("operator certificates match canonical advertised identities and preserve the chain", () => {
  const fixture = certificateFixture();
  const cert = `${fixture.cert}${fixture.cert}`;
  const parsed = parseOperatorCertificate({ cert, key: fixture.key }, "::1");
  expect(parsed.cert).toBe(cert);
  expect(parsed.key).toBe(fixture.key);
  expect(parsed.hash).toEqual({ algorithm: "sha-256", value: "" });
  expect(parsed.expires).toBeGreaterThan(Date.now());
});

test("operator certificate rejects identity, key and parse failures", () => {
  const fixture = certificateFixture();
  expect(() => parseOperatorCertificate(fixture, "wrong.example")).toThrow("hostname");
  expect(() =>
    parseOperatorCertificate({ cert: fixture.cert, key: fixture.otherKey }, "relay.example"),
  ).toThrow("do not match");
  expect(() =>
    parseOperatorCertificate({ cert: fixture.cert, key: "not a private key" }, "relay.example"),
  ).toThrow("private key");
  expect(() =>
    parseOperatorCertificate({ cert: "not a certificate", key: fixture.key }, "relay.example"),
  ).toThrow("certificate");
});

test.each([
  ["127.0.0.1", "DNS:127.0.0.1"],
  ["127.0.0.1", ""],
  ["::1", "DNS:::1"],
])("numeric certificate identity %s requires an IP SAN, not %s", (hostname, san) => {
  const fixture = certificateFixture(hostname, san);
  expect(() => parseOperatorCertificate(fixture, hostname)).toThrow("hostname");
});

test("operator certificate accepts IPv4 IP SAN and DNS SAN controls", () => {
  const fixture = certificateFixture();
  expect(parseOperatorCertificate(fixture, "127.0.0.1").cert).toBe(fixture.cert);
  expect(parseOperatorCertificate(fixture, "relay.example").cert).toBe(fixture.cert);
});
