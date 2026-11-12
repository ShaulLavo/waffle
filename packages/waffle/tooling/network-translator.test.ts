import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  networkTranslatorPin,
  provisionNetworkTranslator,
  publishNetworkTranslator,
} from "./network-translator.js";

test("pinned translator cold/concurrent/warm publication is immutable and corrupt pins fail", async () => {
  const scratch = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "waffle-translator-"));
  try {
    const cache = join(scratch, "tools");
    const [first, second] = await Promise.all([
      provisionNetworkTranslator(cache),
      provisionNetworkTranslator(cache),
    ]);
    expect(first).toBe(second);
    expect(await provisionNetworkTranslator(cache)).toBe(first);
    expect(
      (await readdir(cache)).filter((name) => name.startsWith(".network-translator-")),
    ).toEqual([]);
    for (const code of ["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"]) {
      const published = join(
        cache,
        `network-translator-${(await networkTranslatorPin()).slice(0, 16)}`,
      );
      await publishNetworkTranslator("owned-loser", published, async () => {
        throw Object.assign(Error("winner exists"), { code });
      });
      await expect(
        publishNetworkTranslator("owned-loser", join(cache, "absent"), async () => {
          throw Object.assign(Error("real filesystem failure"), { code });
        }),
      ).rejects.toThrow("real filesystem failure");
    }
    const bytes = await readFile(first);
    await writeFile(first, "corrupt published tool");
    await expect(provisionNetworkTranslator(cache)).rejects.toThrow("corrupt");
    expect(await readFile(first, "utf8")).toBe("corrupt published tool");
    await writeFile(first, bytes);
    expect(await provisionNetworkTranslator(cache)).toBe(first);
    // An incomplete published directory is never replaced, on POSIX or Windows.
    const incomplete = join(scratch, "incomplete");
    const published = join(
      incomplete,
      `network-translator-${(await networkTranslatorPin()).slice(0, 16)}`,
    );
    await cp(new URL("../tooling/network-translator", import.meta.url), published, {
      recursive: true,
    });
    await expect(provisionNetworkTranslator(incomplete)).rejects.toThrow();
    expect(await readdir(published)).toContain("bun.lock");
    console.log("translator cold/concurrent-cold/warm/corrupt/incomplete: pass");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 30000);

test("interrupted private installation cleans only its own temporary directory", async () => {
  const scratch = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "waffle-translator-abort-"));
  const controller = new AbortController();
  try {
    const promise = provisionNetworkTranslator(scratch, controller.signal);
    // Abort after the producer creates its owned install, rather than a preflight-only abort.
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await readdir(scratch)).some((name) => name.startsWith(".network-translator-"))) break;
      await Bun.sleep(1);
    }
    controller.abort(Error("test interrupted"));
    await expect(promise).rejects.toThrow();
    expect(await readdir(scratch)).toEqual([]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 30000);

test("Binaryen is only an isolated producer pin, never a consumer dependency", async () => {
  const manifest: unknown = await Bun.file(new URL("../package.json", import.meta.url)).json();
  expect(JSON.stringify(manifest)).not.toContain('"binaryen"');
  expect(await Bun.file(new URL("../../../bun.lock", import.meta.url)).text()).not.toContain(
    '"binaryen"',
  );
  expect(
    await Bun.file(new URL("../tooling/network-translator/bun.lock", import.meta.url)).text(),
  ).toContain('"binaryen@132.0.0"');
});

test("SIGINT provisioning stops the child and removes its owned install", async () => {
  const scratch = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "waffle-translator-signal-"));
  const module = new URL("../tooling/network-translator.ts", import.meta.url).href;
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `import {provisionNetworkTranslator} from ${JSON.stringify(module)}; await provisionNetworkTranslator(${JSON.stringify(scratch)});`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const output = new Response(child.stdout).text(),
    error = new Response(child.stderr).text();
  try {
    for (let attempt = 0; attempt < 2000; attempt++) {
      if ((await readdir(scratch)).some((name) => name.startsWith(".network-translator-"))) break;
      await Bun.sleep(1);
    }
    child.kill("SIGINT");
    expect(await child.exited).not.toBe(0);
    expect(await readdir(scratch)).toEqual([]);
    await Promise.all([output, error]);
  } finally {
    child.kill();
    await child.exited;
    await rm(scratch, { recursive: true, force: true });
  }
}, 30000);
