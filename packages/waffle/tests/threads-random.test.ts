import { expect, test } from "bun:test";

test("thread random_get copies bounded native random bytes into ordinary and shared guest memory", async () => {
  const child = Bun.spawn(
    ["bun", new URL("./threads-random-control.ts", import.meta.url).pathname],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    const output = await new Response(child.stdout).text();
    const errors = await new Response(child.stderr).text();
    expect(await child.exited, errors).toBe(0);
    expect(JSON.parse(output)).toEqual({
      cases: ["shared", "ordinary"],
      calls: [65536, 65536, 1, 64, 64, 65536, 65536, 1, 64, 64],
    });
  } finally {
    child.kill();
    await child.exited;
  }
});
