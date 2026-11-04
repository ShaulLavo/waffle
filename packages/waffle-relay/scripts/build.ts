import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
await rm(resolve(root, "dist"), { recursive: true, force: true });
await mkdir(resolve(root, "dist"), { recursive: true });
const transpiler = new Bun.Transpiler({ loader: "ts", target: "node" });
for (const file of await readdir(resolve(root, "src"))) {
  if (!file.endsWith(".ts")) continue;
  const code = await Bun.file(resolve(root, "src", file)).text();
  const prefixLength = code.startsWith("#!") ? code.indexOf("\n") + 1 : 0;
  const prefix = code.slice(0, prefixLength);
  await Bun.write(
    resolve(root, "dist", file.replace(/\.ts$/, ".js")),
    prefix + transpiler.transformSync(code.slice(prefixLength)),
  );
}

await chmod(resolve(root, "dist/cli.js"), 0o755);
