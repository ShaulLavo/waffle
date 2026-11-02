import { describe, expect, test } from "bun:test";
import { canonicalDestination, canonicalOrigin, destinationKey } from "../src/tcp-destination.js";
import { resolveDestination, tcpPolicy, tcpLimits, TcpAdmissions } from "../src/tcp-policy.js";
import { mintRelayToken, tokenKey, verifyRelayToken } from "../src/token.js";
import { serveConfig } from "../src/cli-config.js";

const secret = crypto.getRandomValues(new Uint8Array(32));
const target = { host: "db.example", port: 5432 };
describe("canonical TCP authority", () => {
  test("config, requests and scopes share IDNA, case, trailing-dot and mapped keys", () => {
    expect(destinationKey({ host: "BÜCHER.Example.", port: 443 })).toBe(
      destinationKey({ host: "xn--bcher-kva.example", port: 443 }),
    );
    expect(canonicalDestination({ host: "::ffff:127.0.0.1", port: 80 })).toEqual({
      host: "127.0.0.1",
      port: 80,
    });
    expect(canonicalDestination({ host: "2001:4860:0000:0:0:0:0:8888", port: 80 }).host).toBe(
      "2001:4860::8888",
    );
  });
  test.each([
    "127.1",
    "0177.0.0.1",
    "0x7f000001",
    "2130706433",
    "user@db.example",
    "db.example:80",
    "::1%lo",
    "[::1]:80",
    "db..example",
    "*.example",
    "db.example/",
    " db.example",
    "db.example..",
  ])("rejects ambiguous authority %s", (host) => {
    expect(() => canonicalDestination({ host, port: 80 })).toThrow();
  });
  test.each([0, 65536, 1.5, NaN])("rejects port %s", (port) =>
    expect(() => canonicalDestination({ host: "db.example", port })).toThrow(),
  );
  test.each([
    "null",
    "https://app.example/",
    "https://APP.example",
    "https://app.example:443",
    "https://user@app.example",
    "https://app.example https://other.example",
  ])("rejects noncanonical origin %s", (origin) => expect(() => canonicalOrigin(origin)).toThrow());
  test("mail guard covers guest and override ports", () => {
    for (const port of [25, 465, 587]) {
      expect(() =>
        tcpPolicy({ tokenSecret: secret, destinations: [{ host: "mail.example", port }] }, []),
      ).toThrow("Mail");
      expect(() =>
        tcpPolicy(
          {
            tokenSecret: secret,
            destinations: [{ ...target, connect: { host: "127.0.0.1", port } }],
          },
          [],
        ),
      ).toThrow("Mail");
      expect(
        tcpPolicy(
          { tokenSecret: secret, destinations: [{ host: "mail.example", port, allowMail: true }] },
          [],
        ).destinations.size,
      ).toBe(1);
    }
  });
  test("only numeric operator overrides bypass global DNS policy", async () => {
    expect(() =>
      tcpPolicy({ tokenSecret: secret, destinations: [{ ...target, connect: target }] }, []),
    ).toThrow("numeric");
    const connect = { host: "127.0.0.1", port: 5432 };
    expect(
      await resolveDestination({ ...target, connect }, () => {
        throw new Error("must not resolve");
      }),
    ).toEqual(connect);
  });
  test.each([
    "127.0.0.1",
    "10.0.0.1",
    "100.64.0.10",
    "169.254.169.254",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::ffff:8.8.8.8",
    "fe80::1",
    "fc00::1",
    "2001:db8::1",
  ])("rejects forbidden or mixed DNS answers %s", async (address) => {
    const family = address.includes(":") ? 6 : 4;
    await expect(resolveDestination(target, async () => [{ address, family }])).rejects.toThrow(
      "destination-denied",
    );
    await expect(
      resolveDestination(target, async () => [
        { address: "8.8.8.8", family: 4 },
        { address, family },
      ]),
    ).rejects.toThrow("destination-denied");
  });
  test("resolves once, returns the numeric address and does not follow a rebinding answer", async () => {
    let calls = 0;
    const result = await resolveDestination(target, async () => {
      calls++;
      return [{ address: calls === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 }];
    });
    expect(result).toEqual({ host: "8.8.8.8", port: 5432 });
    expect(calls).toBe(1);
    await expect(resolveDestination(target, async () => [])).rejects.toThrow("dns-failed");
    await expect(
      resolveDestination(target, async () => {
        throw new Error("secret address");
      }),
    ).rejects.toThrow("dns-failed");
  });
});
describe("HMAC token boundaries", () => {
  test("integer-second expiry, maximum lifetime, tampering and separate secrets", async () => {
    const token = await mintRelayToken(
      secret,
      { exp: 101, sub: "account", dst: [{ host: "DB.Example.", port: 5432 }] },
      100,
    );
    expect(await verifyRelayToken(await tokenKey(secret), token, 100)).toEqual({
      exp: 101,
      sub: "account",
      dst: [target],
    });
    await expect(verifyRelayToken(await tokenKey(secret), token, 101)).rejects.toThrow(
      "relay-auth",
    );
    await expect(
      verifyRelayToken(await tokenKey(crypto.getRandomValues(new Uint8Array(32))), token, 100),
    ).rejects.toThrow("relay-auth");
    await expect(
      verifyRelayToken(await tokenKey(secret), token.replace("v1.", "v2."), 100),
    ).rejects.toThrow("relay-auth");
    await expect(mintRelayToken(secret, { exp: 101.5 }, 100)).rejects.toThrow();
    await expect(mintRelayToken(secret, { exp: 86501 }, 100)).rejects.toThrow();
    await expect(mintRelayToken(secret, { exp: 101, sub: "line\nbreak" }, 100)).rejects.toThrow();
    expect(() => tokenKey(new Uint8Array(31))).toThrow();
  });
  test("unconfigured issuer is absent; configured issuer scope cannot widen policy", () => {
    expect(tcpPolicy({ tokenSecret: secret }, []).issuer).toBeUndefined();
    expect(() =>
      tcpPolicy(
        {
          tokenSecret: secret,
          issuer: { credential: "a".repeat(32), ttlSeconds: 10, destinations: [target] },
        },
        [],
      ),
    ).toThrow("scope");
  });
});
describe("admission counters and local mode", () => {
  test("relay, subject concurrency, rate and subject-table limits release exactly once", () => {
    const admissions = new TcpAdmissions(
      tcpLimits({
        maxConnections: 1,
        maxConnectionsPerSubject: 1,
        attemptsPerMinute: 2,
        maxSubjects: 1,
      }),
    );
    const release = admissions.reserve();
    expect(() => admissions.reserve()).toThrow("limit");
    release();
    release();
    expect(admissions.active).toBe(0);
    const subject = admissions.subject("a", 0);
    expect(() => admissions.subject("a", 1)).toThrow("limit");
    subject();
    subject();
    expect(() => admissions.subject("a", 2)).toThrow("limit");
    expect(() => admissions.subject("b", 3)).toThrow("limit");
    const next = admissions.subject("b", 60001);
    next();
  });
  test.each([0, -1, 1.5, 2 ** 32])("rejects invalid limits %s", (value) =>
    expect(() => tcpLimits({ maxConnections: value })).toThrow(),
  );
  test("window/header ceilings and disabled idle", () => {
    expect(() => tcpLimits({ windowBytes: 262145 })).toThrow();
    expect(() => tcpLimits({ maxOpenBytes: 8193 })).toThrow();
    expect(tcpLimits({ idleTimeoutMs: 0 }).idleTimeoutMs).toBe(0);
  });
  test("dev requires explicit loopback bind and target, never issuer config", async () => {
    const args = ["serve", "--dev", "--destination", "db.example,5432,127.0.0.1,5432"];
    const config = await serveConfig(args);
    expect(config.options.tcp?.issuer).toBeUndefined();
    expect(config.dev).toBe(true);
    await expect(serveConfig(args.concat(["--listen", "0.0.0.0"]))).rejects.toThrow("loopback");
    await expect(serveConfig(args.concat(["--config", "/not/read"]))).rejects.toThrow();
    await expect(
      serveConfig(["serve", "--dev", "--destination", "db.example,5432,100.64.0.1,5432"]),
    ).rejects.toThrow("loopback");
  });
});
