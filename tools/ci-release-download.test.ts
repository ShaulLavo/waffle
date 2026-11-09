import { releaseCacheInventory } from "./ci-release-cache.ts";
import { nativePrebuild, prebuildCachePath, seedNativePrebuild } from "./ci-native-prebuild.ts";
import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseCacheKey, releaseDownload as downloadRelease } from "./ci-release-download.ts";
import { selectNodeRelease } from "./ci-bootstrap-tools.ts";

const url = "https://github.com/owner/project/releases/download/v1/input.tgz";
const api = "https://api.github.com/repos/owner/project/releases/tags/v1";
const asset = "https://api.github.com/repos/owner/project/releases/assets/42";
const signed = "https://release-assets.githubusercontent.com/input?signature=temporary";
const metadata = () => Response.json({ assets: [{ name: "input.tgz", url: asset }] });
function releaseDownload(input: string, options: Parameters<typeof downloadRelease>[1] = {}) {
  return downloadRelease(input, { cache: undefined, token: "fixture-token", ...options });
}
async function scratch(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "waffle-release-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("release API requests authenticate without sending credentials to signed assets", async () => {
  const requests: { url: string; auth: string | null; redirect?: RequestRedirect }[] = [];
  const download = async (input: string, init?: RequestInit) => {
    requests.push({
      url: input,
      auth: new Headers(init?.headers).get("authorization"),
      redirect: init?.redirect,
    });
    if (input === api) return metadata();
    if (input === asset) return new Response(null, { status: 302, headers: { location: signed } });
    return new Response("archive");
  };
  expect(await (await releaseDownload(url, { fetch: download })).text()).toBe("archive");
  expect(requests).toEqual([
    { url: api, auth: "Bearer fixture-token", redirect: "manual" },
    { url: asset, auth: "Bearer fixture-token", redirect: "manual" },
    { url: signed, auth: null, redirect: "manual" },
  ]);
});

test("complete URL cache is token independent and avoids all API calls on a warm hit", async () => {
  await scratch(async (cache) => {
    let calls = 0;
    const fetch = async (input: string) => {
      calls++;
      return input === api ? metadata() : new Response("archive");
    };
    expect(await (await releaseDownload(url, { cache, fetch })).text()).toBe("archive");
    expect(await (await releaseDownload(url, { cache, token: "different", fetch })).text()).toBe(
      "archive",
    );
    expect(calls).toBe(2);
    expect(await readdir(cache)).toEqual([releaseCacheKey(url)]);
    expect(releaseCacheKey(url)).not.toBe(releaseCacheKey(url.replace("v1/", "v2/")));
  });
});

for (const status of [408, 429, 500, 502, 503, 504]) {
  test(`transient HTTP ${status} stays bounded and reports its final error`, async () => {
    const waits: number[] = [];
    let calls = 0;
    await expect(
      releaseDownload(url, {
        fetch: async () => {
          calls++;
          return new Response(null, { status });
        },
        sleep: async (delay) => {
          waits.push(delay);
        },
      }),
    ).rejects.toThrow(String(status));
    expect(calls).toBe(3);
    expect(waits).toEqual([1000, 2000]);
  });
}

test("a permanent API failure never falls back to the public release URL", async () => {
  const requests: string[] = [];
  await expect(
    releaseDownload(url, {
      fetch: async (input) => {
        requests.push(input);
        return new Response(null, { status: 404 });
      },
    }),
  ).rejects.toThrow("404");
  expect(requests).toEqual([api]);
});

for (const redirect of [
  "https://unrelated.example/input",
  "http://api.github.com/input",
  "https://user:secret@api.github.com/input",
]) {
  test(`unsafe redirect is rejected without forwarding the token: ${new URL(redirect).hostname}`, async () => {
    let calls = 0;
    await expect(
      releaseDownload(url, {
        fetch: async () => {
          calls++;
          return new Response(null, { status: 302, headers: { location: redirect } });
        },
      }),
    ).rejects.toThrow("redirect");
    expect(calls).toBe(1);
  });
}

test("connection failure and redirect loops cannot run indefinitely", async () => {
  let calls = 0;
  await expect(
    releaseDownload(url, {
      fetch: async () => {
        calls++;
        throw new Error("connection closed");
      },
      sleep: async () => {},
    }),
  ).rejects.toThrow("request failed");
  expect(calls).toBe(3);
  calls = 0;
  await expect(
    releaseDownload(url, {
      fetch: async (input) => {
        calls++;
        return new Response(null, { status: 302, headers: { location: input } });
      },
    }),
  ).rejects.toThrow("redirect");
  expect(calls).toBe(4);
});

test("interrupted asset streams cannot publish a partial cache entry", async () => {
  await scratch(async (cache) => {
    const fetch = async (input: string) =>
      input === api
        ? metadata()
        : new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array([1]));
                controller.error(new Error("interrupted"));
              },
            }),
          );
    await expect(releaseDownload(url, { cache, fetch })).rejects.toThrow("interrupted");
    expect(await readdir(cache)).toEqual([]);
  });
});

test("non-release requests receive no job credential", async () => {
  let authorization: string | null = "not-called";
  await releaseDownload("https://ftp.gnu.org/source.tar.gz", {
    fetch: async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      return new Response("source");
    },
  });
  expect(authorization).toBeNull();
});

test("Node CLI consumes cached bytes without Bun and keeps machine-readable stdout clean", async () => {
  await scratch(async (cache) => {
    await writeFile(join(cache, releaseCacheKey(url)), "archive");
    const destination = join(cache, "output");
    const result = spawnSync(
      "node",
      [new URL("./ci-release-download.ts", import.meta.url).pathname, url, destination],
      {
        env: { ...process.env, CI_RELEASE_CACHE: cache, GITHUB_ACTIONS: "true", GITHUB_TOKEN: "" },
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("cache hit");
    expect(await Bun.file(destination).text()).toBe("archive");
  });
});

test("CI without a token fails closed on a cold cache", () => {
  const result = spawnSync(
    "node",
    [new URL("./ci-release-download.ts", import.meta.url).pathname, url, "/unused"],
    {
      env: { ...process.env, CI_RELEASE_CACHE: "", GITHUB_ACTIONS: "true", GITHUB_TOKEN: "" },
      encoding: "utf8",
    },
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("require GITHUB_TOKEN");
});

test("bootstrap preserves exact selectors and resolves a major to the newest stable Linux x64 build", () => {
  const release = (version: string, stable = true) => ({
    version,
    stable,
    files: [
      {
        platform: "linux",
        arch: "x64",
        download_url: `https://github.com/actions/node-versions/releases/download/${version}/node-${version}-linux-x64.tar.gz`,
      },
    ],
  });
  const manifest = [
    release("26.9.0"),
    release("26.12.1"),
    release("26.13.0"),
    release("27.0.0", false),
  ];
  expect(selectNodeRelease(manifest, "26").version).toBe("26.13.0");
  expect(selectNodeRelease(manifest, "26.12.1").version).toBe("26.12.1");
  expect(() => selectNodeRelease(manifest, "latest")).toThrow("Unsupported");
  expect(() => selectNodeRelease(manifest, "24")).toThrow("Missing");
  expect(() =>
    selectNodeRelease(
      [
        {
          ...release("26.12.1"),
          files: [
            {
              platform: "linux",
              arch: "x64",
              download_url: "https://unrelated.example/node.tar.gz",
            },
          ],
        },
      ],
      "26",
    ),
  ).toThrow("Invalid");
});

test("cache inventory is stable on warm runs, grows for new URLs and ignores interrupted stages", async () => {
  await scratch(async (cache) => {
    const empty = await releaseCacheInventory(cache);
    expect(empty.count).toBe(0);
    await writeFile(join(cache, releaseCacheKey(url)), "archive");
    const first = await releaseCacheInventory(cache);
    expect(first.count).toBe(1);
    expect(first.hash).not.toBe(empty.hash);
    expect(await releaseCacheInventory(cache)).toEqual(first);
    await writeFile(join(cache, ".download-interrupted"), "partial");
    expect(await releaseCacheInventory(cache)).toEqual(first);
    await writeFile(join(cache, releaseCacheKey(url.replace("v1/", "v2/"))), "archive");
    const grown = await releaseCacheInventory(cache);
    expect(grown.count).toBe(2);
    expect(grown.hash).not.toBe(first.hash);
  });
});

test("native prebuild uses the locked installer's cache path without accepting unverified bytes", async () => {
  await scratch(async (cache) => {
    const path = prebuildCachePath(cache, nativePrebuild.url);
    expect(path).toBe(
      join(
        cache,
        "_prebuilds/a11ff5-webtransport-transport-http3-quiche-v1.6.11-napi-v6-linux-x64.tar.gz",
      ),
    );
    await expect(seedNativePrebuild(cache, async () => new Response("corrupt"))).rejects.toThrow(
      "checksum mismatch",
    );
    expect(await readdir(cache)).toEqual([]);
    await expect(
      seedNativePrebuild(cache, async () => new Response(null, { status: 504 })),
    ).rejects.toThrow("504");
  });
});

test("cache CLI does not request a save for an unchanged warm inventory", async () => {
  await scratch(async (cache) => {
    const initial = await releaseCacheInventory(cache);
    const output = join(cache, "output");
    const script = new URL("./ci-release-cache.ts", import.meta.url).pathname;
    const env = {
      ...process.env,
      CI_RELEASE_CACHE: cache,
      CI_RELEASE_CACHE_INITIAL: initial.hash,
      GITHUB_OUTPUT: output,
    };
    const warm = spawnSync("node", [script, "save"], { env, encoding: "utf8" });
    expect(warm.status, warm.stderr).toBe(0);
    expect(await Bun.file(output).text()).toContain("changed=false");
    await writeFile(join(cache, releaseCacheKey(url)), "archive");
    await writeFile(output, "");
    const grown = spawnSync("node", [script, "save"], { env, encoding: "utf8" });
    expect(grown.status, grown.stderr).toBe(0);
    expect(await Bun.file(output).text()).toContain("changed=true");
    const current = await releaseCacheInventory(cache);
    await writeFile(output, "");
    const unchanged = spawnSync("node", [script, "save"], {
      env: { ...env, CI_RELEASE_CACHE_INITIAL: current.hash },
      encoding: "utf8",
    });
    expect(unchanged.status, unchanged.stderr).toBe(0);
    expect(await Bun.file(output).text()).toContain("changed=false");
  });
});
