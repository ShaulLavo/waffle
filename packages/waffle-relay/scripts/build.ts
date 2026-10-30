import { mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
await rm(resolve(root, "dist"), { recursive: true, force: true });
await mkdir(resolve(root, "dist"), { recursive: true });
const transpiler = new Bun.Transpiler({ loader: "ts", target: "node" });
for (const file of await readdir(resolve(root, "src"))) {
  if (!file.endsWith(".ts")) continue;
  const code = await Bun.file(resolve(root, "src", file)).text();
  await Bun.write(
    resolve(root, "dist", file.replace(/\.ts$/, ".js")),
    transpiler.transformSync(code),
  );
}
