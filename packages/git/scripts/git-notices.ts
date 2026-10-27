import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Buffer } from "buffer/index.js";
const inputs: unknown = JSON.parse(await readFile(".build/git-inputs.json", "utf8"));
assert.ok(Array.isArray(inputs), "Build Git before generating its notices");
const packages = new Set<string>();
for (const input of inputs) {
  assert.equal(typeof input, "string");
  const marker = input.lastIndexOf("node_modules/");
  if (marker < 0) continue;
  const segments = input.slice(marker + 13).split("/");
  const packagePath = segments.slice(0, segments[0].startsWith("@") ? 2 : 1).join("/");
  packages.add(resolve(input.slice(0, marker + 13), packagePath));
}
let notices =
  "# Local Git dependency notices\n\nGenerated from the browser bundle by npm run notices:git.\n";
for (const directory of Array.from(packages).sort()) {
  const manifest: unknown = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8"));
  assert.ok(
    manifest && typeof manifest === "object" && "name" in manifest && "version" in manifest,
  );
  assert.ok(typeof manifest.name === "string" && typeof manifest.version === "string");
  const files = (await readdir(directory))
    .filter((name) => /^(license|licence|copying|notice)([.-]|$)/i.test(name))
    .sort();
  if (files.length === 0) {
    notices += await embeddedNotices(directory, manifest.name);
    continue;
  }
  for (const file of files)
    notices += `\n## ${manifest.name} ${manifest.version} / ${file}\n\n${await readFile(resolve(directory, file), "utf8")}\n`;
}
await mkdir("dist", { recursive: true });
await writeFile("dist/git.NOTICES.txt", notices);
console.log(
  `Git browser dependency notices: ${packages.size} packages, ${Buffer.byteLength(notices)} bytes`,
);

async function embeddedNotices(directory: string, packageName: string) {
  if (packageName === "clean-git-ref")
    return `\n## clean-git-ref 2.0.1, Eli White, Apache-2.0\n\n${await readFile("third-party/git/Apache-2.0.txt", "utf8")}\n`;
  assert.equal(packageName, "diff3", `No license found: ${packageName}`);
  let output = "";
  for (const file of ["diff3.js", "onp.js"]) {
    const source = await readFile(resolve(directory, file), "utf8");
    const prefix = source.match(/^(?:\/\/[^\n]*\n)+|^\/\*[\s\S]*?\*\//)?.[0];
    assert.ok(prefix?.includes("Permission is hereby granted"), `No embedded license in ${file}`);
    output += `\n## diff3 0.0.3 / ${file} source license\n\n${prefix}\n`;
  }
  return output;
}
