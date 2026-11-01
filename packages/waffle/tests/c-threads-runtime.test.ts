import { expect, test } from "bun:test";

const directory = process.env.C_THREAD_FIXTURE_DIR;
const runner = new URL("./c-threads-runtime-browser-runner.ts", import.meta.url).pathname;

test("the C Runtime runner requires an explicit artifact and never builds one", async () => {
  const child = Bun.spawn([process.execPath, runner, "--bun"], {
    env: { ...process.env, C_THREAD_FIXTURE_DIR: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const errors = await new Response(child.stderr).text();
    await new Response(child.stdout).text();
    expect(await child.exited).not.toBe(0);
    expect(errors).toContain("set C_THREAD_FIXTURE_DIR");
  } finally {
    child.kill();
    await child.exited;
  }
});

for (const mode of ["pair", "repeat", "nested"]) {
  test.skipIf(!directory)(
    `retained C pthread ${mode} passes the real Bun Runtime`,
    async () => {
      const child = Bun.spawn([process.execPath, runner, "--bun", "--case", mode], {
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        const output = await new Response(child.stdout).text();
        const errors = await new Response(child.stderr).text();
        expect(await child.exited, output.concat(errors)).toBe(0);
      } finally {
        child.kill();
        await child.exited;
      }
    },
    30_000,
  );
}
