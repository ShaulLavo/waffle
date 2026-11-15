import { expect, test } from "bun:test";

test("actual providers retain live shared buffers across other-agent growth", async () => {
  const child = Bun.spawn(
    [process.execPath, `${import.meta.dir}/fixtures/stable-memory-reader.ts`],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(JSON.parse(stdout)).toMatchObject({
      "reader-getter-other-grow": { finalBytes: 262144, getterCalls: 64 },
      "reader-stable-other-grow": { finalBytes: 262144, getterCalls: 0 },
    });
  } finally {
    child.kill();
    await child.exited;
  }
}, 30000);
