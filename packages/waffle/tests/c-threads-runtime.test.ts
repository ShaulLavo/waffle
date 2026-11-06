import { expect, test } from "bun:test";
import { bytes } from "../memory/index.ts";
import { cThreadControlDebt } from "./c-threads-runtime-browser.ts";

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

test("the C acceptance gate retains exact private control debts", () => {
  const snapshot: Parameters<typeof cThreadControlDebt>[0] = {
    debtBytes: 240,
    holders: Array.from({ length: 3 }, () => ({
      label: "guest-control",
      scope: "worker",
      state: "debt",
      declaredBytes: 80,
      grownBytes: null,
      shape: { kind: "fixed-buffer", length: bytes(80) },
    })),
  };
  expect(cThreadControlDebt(snapshot, 2).passed).toBe(true);
  expect(cThreadControlDebt({ ...snapshot, debtBytes: 0 }, 2).passed).toBe(false);
  expect(cThreadControlDebt({ ...snapshot, holders: snapshot.holders.slice(1) }, 2).passed).toBe(
    false,
  );
  const changed = snapshot.holders.map((holder) => ({ ...holder, declaredBytes: 64 }));
  expect(cThreadControlDebt({ ...snapshot, holders: changed }, 2).passed).toBe(false);
  expect(cThreadControlDebt(snapshot, 16).passed).toBe(false);
});
