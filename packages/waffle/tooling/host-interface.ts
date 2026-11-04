import assert from "node:assert/strict";

const hostInterfaceField = "waffleHostInterface" as const;
const wafflePackageName = "waffle" as const;

export type HostInterface = number & {
  readonly __brand: "WaffleHostInterface";
};

export type PackageManifest = Record<string, unknown>;

function record(value: unknown, source: string): PackageManifest {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${source} must be an object`,
  );
  return value as PackageManifest;
}

function dependencyRecord(manifest: PackageManifest, field: string, source: string) {
  const value = manifest[field];
  if (value === undefined) return {};
  return record(value, `${source}.${field}`);
}

export function parseHostInterface(value: unknown, source: string): HostInterface {
  assert.ok(
    typeof value === "number" && Number.isSafeInteger(value) && value > 0,
    `${source}.${hostInterfaceField} must be a positive safe integer`,
  );
  return value as HostInterface;
}

export function readHostInterface(manifest: PackageManifest, source: string): HostInterface {
  return parseHostInterface(manifest[hostInterfaceField], source);
}

export function assertExactHostInterface(
  required: HostInterface,
  provided: HostInterface,
  source: string,
): void {
  assert.equal(
    required,
    provided,
    `${source} requires ${hostInterfaceField} ${required}, runtime provides ${provided}`,
  );
}

export function isWaffleFamilyManifest(manifest: PackageManifest): boolean {
  if (Object.hasOwn(manifest, hostInterfaceField) && manifest.name !== wafflePackageName)
    return true;
  return ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"].some(
    (field) => {
      const dependencies = manifest[field];
      return (
        dependencies !== null &&
        typeof dependencies === "object" &&
        !Array.isArray(dependencies) &&
        Object.hasOwn(dependencies, wafflePackageName)
      );
    },
  );
}

export function assertWaffleFamilyManifest(
  manifest: PackageManifest,
  source: string,
): HostInterface {
  const required = readHostInterface(manifest, source);
  const peers = dependencyRecord(manifest, "peerDependencies", source);
  assert.equal(
    peers[wafflePackageName],
    "*",
    `${source}.peerDependencies.${wafflePackageName} must be "*"`,
  );

  for (const field of ["dependencies", "optionalDependencies"] as const) {
    const dependencies = dependencyRecord(manifest, field, source);
    assert.ok(
      !Object.hasOwn(dependencies, wafflePackageName),
      `${source}.${field}.${wafflePackageName} must be absent; use the wildcard peer only`,
    );
  }
  return required;
}

export function assertSourceWaffleFamilyManifest(
  manifest: PackageManifest,
  source: string,
  provided: HostInterface,
): HostInterface {
  const required = assertWaffleFamilyManifest(manifest, source);
  assertExactHostInterface(required, provided, source);
  const devDependencies = dependencyRecord(manifest, "devDependencies", source);
  assert.equal(
    devDependencies[wafflePackageName],
    "workspace:*",
    `${source}.devDependencies.${wafflePackageName} must be "workspace:*"`,
  );
  return required;
}

export function assertRuntimeManifest(manifest: PackageManifest, source: string): HostInterface {
  assert.equal(manifest.name, wafflePackageName, `${source}.name must be ${wafflePackageName}`);
  return readHostInterface(manifest, source);
}
