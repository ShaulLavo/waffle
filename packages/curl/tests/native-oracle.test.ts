import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { runCurl } from "../src/curl.ts";
import { cleanupFixtures, fixture, invocation } from "./helpers.ts";

// Hooks belong to this test file, not the cached helper module.
afterEach(cleanupFixtures);

async function native(args: readonly string[], input: Uint8Array) {
  const child = spawn(
    "/usr/bin/curl",
    ["--max-time", "1", "--silent", "--show-error"].concat(args),
    {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 2000,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: "/nonexistent-waffle-curl-fixture",
        CURL_HOME: "/nonexistent-waffle-curl-fixture",
        LC_ALL: "C",
      },
    },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const result = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  try {
    const code = await result;
    if (code === null) throw new Error("native curl was terminated without a normal exit");
    return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

test("owned HTTP fixtures match native curl body and exit behavior", async () => {
  const server = await fixture();
  const input = new Uint8Array([65, 0, 10, 13, 255]);
  const cases = [
    { flags: [], path: "/ok" },
    { flags: [], path: "/missing" },
    { flags: ["-f"], path: "/missing" },
    { flags: ["-fs"], path: "/missing" },
    { flags: ["-fsS"], path: "/missing" },
    { flags: [], path: "/redirect" },
    { flags: ["-L"], path: "/redirect" },
    { flags: ["-X", "PATCH", "-H", "x-test: synthetic", "-d", "one", "-d", "two"], path: "/echo" },
    { flags: ["--data-binary", "@-"], path: "/echo" },
    { flags: ["--data", "@-"], path: "/echo" },
    { flags: ["-L", "--data-binary", "@-"], path: "/post-redirect" },
  ];
  for (const entry of cases) {
    const args = entry.flags.concat(`${server.url}${entry.path}`);
    const actual = invocation(args, input);
    const reference = await native(args, input);
    expect(await runCurl(actual.call)).toBe(reference.code);
    expect(actual.stdout.bytes()).toEqual(reference.stdout);
  }
});

test("HEAD and include match visible fixture headers, not invented wire metadata", async () => {
  const server = await fixture();
  for (const flag of ["-I", "-i", "-fI", "-fi"]) {
    const args = [flag, `${server.url}${flag.includes("f") ? "/missing" : "/ok"}`];
    const actual = invocation(args);
    const reference = await native(args, new Uint8Array());
    expect(await runCurl(actual.call)).toBe(reference.code);
    const nativeText = reference.stdout.toString();
    expect(nativeText).toContain(
      flag.includes("f") ? "HTTP/1.1 404 Not Found\r\n" : "HTTP/1.1 200 OK\r\n",
    );
    expect(actual.stdout.text()).toStartWith(
      flag.includes("f") ? "HTTP 404 Not Found\r\n" : "HTTP 200 OK\r\n",
    );
    for (const header of [
      "content-type: text/plain",
      `content-length: ${flag.includes("f") ? 8 : 6}`,
      "x-fixture: owned",
    ]) {
      expect(nativeText.toLowerCase()).toContain(header);
      expect(actual.stdout.text()).toContain(header);
    }
    expect(actual.stdout.text().endsWith("hello\n")).toBe(flag === "-i");
  }
});
