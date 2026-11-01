import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
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
    expect(workflow).toContain(
      "git fetch --depth=1 origin 5f3d329f35be618e5b4d822c0ee933bbfd9a10f5",
    );
    expect(workflow).toContain("password: ${{ secrets.GITHUB_TOKEN }}");
    expect(workflow).toContain('DOCKER_CONFIG="$RUNNER_TEMP/anonymous" docker pull');
    expect(workflow).toContain("jq -r .config.digest image/published-manifest.json");
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
  test("has one exact Origin, empty destinations and no issuer or native endpoint", () => {
    const policy = JSON.parse(read("../container/relay.json"));
    expect(policy.allowedOrigins).toEqual(["https://waffle-network.sprockt.dev"]);
    expect(policy.tcp.destinations).toEqual([]);
    expect(policy.tcp.issuer).toBeUndefined();
    expect(policy.tcp.webtransport).toBeUndefined();
    expect(policy.tcp.tokenSecretFile).toBeUndefined();
    expect(policy.tcp.limits.maxConnections).toBe(16);
    expect(policy.tcp.limits.maxConnectionsPerSubject).toBe(4);
    expect(policy.tcp.limits.windowBytes).toBe(65536);
  });
});
