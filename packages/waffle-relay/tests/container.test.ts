import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serveConfig } from "../src/cli-config.js";
import { destinationKey } from "../src/tcp-destination.js";
import { resolveDestination, tcpPolicy } from "../src/tcp-policy.js";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const configPath = fileURLToPath(new URL("../container/relay.json", import.meta.url));
const target = { host: "waffle-relay-public.sprockt.dev", port: 80 };
const workflow = read("../../../.github/workflows/relay-image.yml");
const dockerfile = read("../container/Dockerfile");

describe("relay image publication contract", () => {
  test("only a reviewed main dispatch can receive package write authority", () => {
    expect(workflow).not.toContain("pull_request_target");
    expect(workflow.match(/packages: write/g)).toHaveLength(1);
    expect(workflow).toContain(
      "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'",
    );
    expect(workflow).toContain("github.repository == 'ShaulLavo/waffle'");
    expect(workflow).toContain("needs: qualify");
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("password: ${{ secrets.GITHUB_TOKEN }}");
    expect(workflow).toContain('DOCKER_CONFIG="$RUNNER_TEMP/anonymous" docker pull');
    expect(workflow).toContain("relay-image-custody.ts published image");
  });
  test("pins public release inputs and installs no optional native peers or scripts", () => {
    expect(dockerfile).toContain(
      "9d09a088be40a970e2b690a9fb13ad69a0fc529d7b98e9be6a11ba1e9176f0a1",
    );
    expect(dockerfile).toContain(
      "874314dbfb2263b5fa5ffc1d04a668440fe0fb2999d50567deee3c46cebb9302",
    );
    expect(dockerfile).toContain(
      "83e429364a8115f445e3ef8c13d601920f45e007f9b83e054c5e34a07c483538",
    );
    expect(dockerfile).toContain("npm ci --omit=optional --ignore-scripts");
    expect(dockerfile).toContain("USER 1000:1000");
  });
  test("has one exact Origin, one exact destination and no issuer or native endpoint", () => {
    const policy = JSON.parse(read("../container/relay.json"));
    expect(policy.allowedOrigins).toEqual(["https://waffle-network.sprockt.dev"]);
    expect(policy.tcp.destinations).toEqual([target]);
    expect(policy.tcp.issuer).toBeUndefined();
    expect(policy.tcp.webtransport).toBeUndefined();
    expect(policy.tcp.tokenSecretFile).toBeUndefined();
    expect(policy.tcp.limits.maxConnections).toBe(16);
    expect(policy.tcp.limits.maxConnectionsPerSubject).toBe(4);
    expect(policy.tcp.limits.windowBytes).toBe(65536);
  });
  test("admits only the selected public name and port, without an override", async () => {
    const config = await serveConfig(["serve", "--config", configPath], {
      WAFFLE_RELAY_TOKEN_SECRET: randomBytes(32).toString("hex"),
    });
    const tcp = config.options.tcp!;
    const policy = tcpPolicy(tcp, config.options.allowedOrigins);
    expect(Array.from(policy.destinations.values())).toEqual([target]);
    expect(policy.issuer).toBeUndefined();
    for (const other of [
      { host: target.host, port: 443 },
      { host: "waffle-network.sprockt.dev", port: 80 },
      { host: "1.1.1.1", port: 80 },
    ])
      expect(policy.destinations.has(destinationKey(other))).toBe(false);
    const entry = policy.destinations.get(destinationKey(target))!;
    const answer = (address: string) => async () => [{ address, family: 4 }];
    expect(await resolveDestination(entry, answer("1.1.1.1"))).toEqual({
      host: "1.1.1.1",
      port: 80,
    });
    await expect(resolveDestination(entry, answer("10.0.0.1"))).rejects.toThrow(
      "destination-denied",
    );
  });
});
