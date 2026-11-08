import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import manifest from "../package.json" with { type: "json" };
import { verifyNativeInstallation } from "../src/webtransport-integrity.js";

const nativeName = "@fails-components/webtransport-transport-http3-quiche";
const mainName = "@fails-components/webtransport";

type Preparation = {
  resolve: (specifier: string) => string;
  install: (entry: string, root: string) => void;
  verify: () => Promise<void>;
};

function requirePackage(entry: string, expectedName: typeof nativeName | typeof mainName): string {
  const root = dirname(dirname(realpathSync(entry)));
  const metadata: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const version = manifest.devDependencies[expectedName];
  if (
    !metadata ||
    typeof metadata !== "object" ||
    !("name" in metadata) ||
    metadata.name !== expectedName ||
    !("version" in metadata) ||
    metadata.version !== version
  )
    throw new Error(`Native relay setup requires ${expectedName}@${version} at ${root}`);
  return root;
}

function install(entry: string, root: string): void {
  const installer = createRequire(entry).resolve("prebuild-install/bin.js");
  execFileSync(
    "node",
    [
      installer,
      "--runtime=napi",
      "--target=6",
      `--platform=${process.platform}`,
      `--arch=${process.arch}`,
      "--verbose",
    ],
    { cwd: root, stdio: "inherit" },
  );
}

function requireUnshadowedPrebuild(root: string): void {
  for (const shadow of [
    `build_${process.platform}_${process.arch}`,
    "build/Debug/webtransport.node",
  ]) {
    const path = join(root, shadow);
    if (existsSync(path)) throw new Error(`Native relay prebuild would be shadowed by ${path}`);
  }
}

export async function prepareNativeRelay(options: Preparation): Promise<string> {
  const entry = options.resolve(nativeName);
  const root = requirePackage(entry, nativeName);
  requirePackage(options.resolve(mainName), mainName);
  const artifact = join(root, "build/Release/webtransport.node");
  requireUnshadowedPrebuild(root);
  options.install(entry, root);
  requireUnshadowedPrebuild(root);
  const bytes = statSync(artifact);
  if (!bytes.isFile() || bytes.size === 0)
    throw new Error(`Native relay setup requires a nonempty file at ${artifact}`);
  await options.verify();
  return artifact;
}

if (import.meta.main) {
  const artifact = await prepareNativeRelay({
    resolve: (specifier) => fileURLToPath(import.meta.resolve(specifier)),
    install,
    verify: verifyNativeInstallation,
  });
  console.log(`Verified required native relay prebuild: ${artifact}`);
}
