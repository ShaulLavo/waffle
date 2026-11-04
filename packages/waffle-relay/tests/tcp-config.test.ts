import { expect, test } from "bun:test";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { serveConfig } from "../src/cli-config.js";

test("operator config contains secret references, validates permissions, and rejects inline secrets", async () => {
  const scratch = await mkdtemp(
    join(
      process.env.WAFFLE_RELAY_TMPDIR ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir()),
      "waffle-relay-config-",
    ),
  );
  const path = join(scratch, "config.json"),
    tokenFile = join(scratch, "token"),
    issuerFile = join(scratch, "issuer");
  try {
    await writeFile(tokenFile, randomBytes(32).toString("hex"), { mode: 0o600 });
    await writeFile(issuerFile, randomBytes(32).toString("hex"), { mode: 0o600 });
    const config = {
      listen: { host: "127.0.0.1", port: 0 },
      allowedOrigins: ["https://app.example"],
      tcp: {
        tokenSecretFile: tokenFile,
        destinations: [{ host: "db.example", port: 5432 }],
        webtransport: {
          bind: { host: "0.0.0.0", port: 4433 },
          advertisedUrl: "https://relay.example:4433/v1/tcp/wt",
        },
        limits: { maxConnections: 2 },
        issuer: {
          credentialFile: issuerFile,
          ttlSeconds: 60,
          destinations: [{ host: "db.example", port: 5432 }],
        },
      },
    };
    await writeFile(path, JSON.stringify(config));
    const result = await serveConfig(["serve", "--config", path], {});
    expect(result.dev).toBe(false);
    expect(result.options.tcp?.limits?.maxConnections).toBe(2);
    expect(result.options.tcp?.issuer?.ttlSeconds).toBe(60);
    expect(
      result.options.tcp && "webtransport" in result.options.tcp
        ? result.options.tcp.webtransport
        : undefined,
    ).toMatchObject({
      bind: { host: "0.0.0.0", port: 4433 },
      advertisedUrl: "https://relay.example:4433/v1/tcp/wt",
    });
    await chmod(tokenFile, 0o644);
    await expect(serveConfig(["serve", "--config", path], {})).rejects.toThrow("0600");
    await chmod(tokenFile, 0o600);
    await writeFile(
      path,
      JSON.stringify({ ...config, tcp: { ...config.tcp, tokenSecret: "inline-not-allowed" } }),
    );
    await expect(serveConfig(["serve", "--config", path], {})).rejects.toThrow("Unknown");
    await writeFile(
      path,
      JSON.stringify({
        ...config,
        tcp: {
          ...config.tcp,
          webtransport: { host: "127.0.0.1", port: 4433 },
        },
      }),
    );
    await expect(serveConfig(["serve", "--config", path], {})).rejects.toThrow("WebTransport");
    await writeFile(
      path,
      JSON.stringify({ ...config, tcp: { ...config.tcp, limits: { nonsense: 1 } } }),
    );
    await expect(serveConfig(["serve", "--config", path], {})).rejects.toThrow("Unknown");
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
});

test("manual certificate startup failure leaves the CLI's HTTP service alive instead of restarting", async () => {
  const { tcpStartup } = await import("../src/cli-config.js");
  await expect(
    tcpStartup({
      ready: Promise.reject(new Error("expired certificate")),
      failure: Promise.resolve({ code: "certificate-expired", manualActionRequired: true }),
    }),
  ).resolves.toBeUndefined();
  await expect(
    tcpStartup({
      ready: Promise.reject(new Error("bind failed")),
      failure: Promise.resolve({ code: "endpoint-failed", manualActionRequired: false }),
    }),
  ).rejects.toThrow("bind failed");
});
