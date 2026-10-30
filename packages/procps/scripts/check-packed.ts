import { mkdtemp, mkdir, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const scratch = await mkdtemp(join(tmpdir(), "waffle-procps-packed-"));
try {
  await run(
    [process.execPath, "pm", "pack", "--destination", scratch],
    new URL("..", import.meta.url).pathname,
  );
  const archives = (await readdir(scratch)).filter((name) => name.endsWith(".tgz"));
  if (archives.length !== 1) throw new Error("Expected one procps archive");
  const archive = join(scratch, archives[0]!);
  await run(["tar", "-xzf", archive, "-C", scratch]);
  await mkdir(join(scratch, "package", "node_modules"));
  await symlink(
    new URL("../../waffle", import.meta.url).pathname,
    join(scratch, "package", "node_modules", "waffle"),
  );
  await mkdir(join(scratch, "node_modules"));
  await symlink(join(scratch, "package"), join(scratch, "node_modules", "waffle-procps"));
  await run([
    process.execPath,
    new URL("packed-acceptance.ts", import.meta.url).pathname,
    join(scratch, "consumer.ts"),
  ]);
  const bytes = new Uint8Array(await Bun.file(archive).arrayBuffer());
  console.log(
    JSON.stringify({
      kind: "packed-runtime-acceptance",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }),
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}

async function run(argv: string[], cwd?: string) {
  const child = Bun.spawn(argv, { cwd, stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`Command failed with status ${code}: ${argv[0]}`);
}
