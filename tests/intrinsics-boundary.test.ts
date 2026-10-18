import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { enforcedModules, payloadExceptions, scanAuthorityProject } from "../tooling/private-authority.ts";

const root = resolve(import.meta.dir, "..");
const fixture = "tests/fixtures/private-authority-cases.ts";

describe("private process authority builtin boundary", () => {
  test("guest-realm implementation does not hand private state to mutable builtins", async () => {
    const findings = await scanAuthorityProject(root, [fixture]);
    const production = findings.filter((finding) => finding.file !== fixture);
    expect(production).toEqual([]);
    const cases = findings.filter((finding) => finding.file === fixture);
    const rejected = new Set(Array.from(cases, (finding) => finding.scope));
    for (const name of ["liveAtomics", "liveConstructor", "liveGetter", "liveSubview", "privateMap", "inferredMap", "liveIteration", "liveSpread", "liveArrayMethod", "liveArrayFrom", "liveReflection", "liveApply", "liveCall", "liveBind", "liveProxy", "species", "iterator", "aliasedBuiltin", "aliasedConstructor", "privateFunctionReceiver", "renamedCaptureGetter", "livePrototypeCall"]) expect(rejected.has(name), name).toBe(true);
    for (const name of ["captured", "indexed", "ordinaryPayload", "runtimeMethod", "plainObjectSpread", "harmlessText", "ordinaryNamedCall", "renamedCaptured"]) expect(rejected.has(name), name).toBe(false);
    expect(cases.some((finding) => finding.rule === "mutable-getter")).toBe(true);
    expect(cases.some((finding) => finding.rule === "private-iteration")).toBe(true);
    expect(cases.some((finding) => finding.rule === "species")).toBe(true);
  }, 20_000);

  test("exceptions explain a precise payload boundary, not a whole implementation", () => {
    expect(enforcedModules).toContain("core/descriptors.ts");
    expect(enforcedModules).toContain("browser/runtime-terminals.ts");
    expect(enforcedModules).toContain("proc/worker-pipes.ts");
    for (const entry of payloadExceptions) {
      expect(enforcedModules).toContain(entry.file);
      expect(entry.scope).not.toBe("<module>");
      expect(entry.expression.length).toBeGreaterThan(0);
      expect(entry.reason.length).toBeGreaterThan(30);
    }
  });
});
