import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("actual Node Worker return releases SDK controller closures with the original eight-turn GC bound", async () => {
  const directory = await mkdtemp(join(tmpdir(), "waffle-root-return-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const output = join(directory, "root-return-gc.mjs");
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, "fixtures/root-return-gc.ts")],
      target: "node",
    });
    expect(built.success).toBe(true);
    await Bun.write(output, built.outputs[0]!);
    child = Bun.spawn(["node", "--expose-gc", "--test", output], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ status, stdout, stderr }).toMatchObject({ status: 0, stderr: "" });
  } finally {
    child?.kill();
    await child?.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
