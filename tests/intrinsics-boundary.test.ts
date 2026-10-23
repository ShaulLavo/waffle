import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { Int32Array as UnlistedView } from "./fixtures/intrinsics.ts";
import type * as Intrinsics from "../proc/intrinsics.ts";
import {
  enforcedModules,
  payloadExceptions,
  scanAuthorityProject,
} from "../tooling/private-authority.ts";

const root = resolve(import.meta.dir, "..");
const fixture = "tests/fixtures/private-authority-cases.ts";

async function isolatedIntrinsics(
  cryptoHost: { getRandomValues: typeof crypto.getRandomValues; randomUUID?: () => string } = {
    getRandomValues: crypto.getRandomValues.bind(crypto),
  },
) {
  const built = await Bun.build({
    entrypoints: [resolve(root, "proc/intrinsics.ts")],
    target: "browser",
    format: "cjs",
  });
  if (!built.success || !built.outputs[0]) throw new Error("cannot bundle isolated intrinsics");
  const source = (await built.outputs[0].text()).concat(
    "\nglobalThis.captured = { arrayAppend: module.exports.arrayAppend, cryptoRandomUUID: module.exports.cryptoRandomUUID }; globalThis.guestObject = Object;\n",
  );
  const context = {
    module: { exports: {} },
    crypto: cryptoHost,
    setTimeout,
    captured: undefined as unknown as Pick<typeof Intrinsics, "arrayAppend" | "cryptoRandomUUID">,
    guestObject: undefined as unknown as ObjectConstructor,
  };
  runInNewContext(source, context);
  return context;
}

describe("private process authority builtin boundary", () => {
  test("captured array appends ignore inherited descriptor fields and replaced defineProperty", async () => {
    const { captured, guestObject } = await isolatedIntrinsics();
    const inherited = () => {
      throw new Error("inherited descriptor field consulted");
    };
    const descriptor = { __proto__: null, configurable: true, get: inherited };
    for (const key of ["get", "set", "value"])
      guestObject.defineProperty(guestObject.prototype, key, descriptor);
    guestObject.defineProperty = inherited;
    const value = {},
      entries: object[] = [];
    captured.arrayAppend(entries, value);
    expect(entries).toEqual([value]);
    expect(Object.getOwnPropertyDescriptor(entries, "0")).toEqual({
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  });

  test("UUID capture retains both its method and crypto receiver", async () => {
    const cryptoHost = {
      getRandomValues: crypto.getRandomValues.bind(crypto),
      randomUUID() {
        expect(this).toBe(cryptoHost);
        return "captured-uuid";
      },
    };
    const context = await isolatedIntrinsics(cryptoHost);
    cryptoHost.randomUUID = () => "guest-uuid";
    context.crypto = {
      getRandomValues: cryptoHost.getRandomValues,
      randomUUID: () => "replaced-crypto-uuid",
    };
    expect(context.captured.cryptoRandomUUID()).toBe("captured-uuid");
  });

  test("capturing absent UUID allocation allows core imports but never uses a later replacement", async () => {
    const { captured, crypto: cryptoHost } = await isolatedIntrinsics();
    expect(typeof captured.arrayAppend).toBe("function");
    cryptoHost.randomUUID = () => "guest-uuid";
    expect(() => captured.cryptoRandomUUID()).toThrow(/undefined|function/);
  });

  test("guest-realm implementation does not hand private state to mutable builtins", async () => {
    const findings = await scanAuthorityProject(root, [fixture]);
    const production = findings.filter((finding) => finding.file !== fixture);
    expect(production).toEqual([]);
    const cases = findings.filter((finding) => finding.file === fixture);
    const rejected = new Set(Array.from(cases, (finding) => finding.scope));
    for (const name of [
      "liveAtomics",
      "liveConstructor",
      "liveGetter",
      "liveSubview",
      "privateMap",
      "inferredMap",
      "liveIteration",
      "liveSpread",
      "liveArrayMethod",
      "liveArrayFrom",
      "liveReflection",
      "liveApply",
      "liveCall",
      "liveBind",
      "liveProxy",
      "species",
      "iterator",
      "aliasedBuiltin",
      "aliasedConstructor",
      "privateFunctionReceiver",
      "renamedCaptureGetter",
      "livePrototypeCall",
      "inheritedDescriptor",
      "inheritedOptions",
      "inheritedPropertyMap",
      "inheritedProxyHandler",
      "liveIdentity",
      "liveMessage",
    ])
      expect(rejected.has(name), name).toBe(true);
    for (const name of [
      "captured",
      "indexed",
      "ordinaryPayload",
      "runtimeMethod",
      "plainObjectSpread",
      "harmlessText",
      "ordinaryNamedCall",
      "renamedCaptured",
      "capturedDescriptor",
    ])
      expect(rejected.has(name), name).toBe(false);
    expect(cases.some((finding) => finding.rule === "mutable-getter")).toBe(true);
    expect(cases.some((finding) => finding.rule === "private-iteration")).toBe(true);
    expect(cases.some((finding) => finding.rule === "species")).toBe(true);
    expect(cases.some((finding) => finding.rule === "native-conversion")).toBe(true);
    expect(cases.some((finding) => finding.rule === "authority-global")).toBe(true);
    expect(enforcedModules).toContain("proc/intrinsics.ts");
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

function unlistedConstructor(buffer: SharedArrayBuffer): Int32Array {
  return new UnlistedView(buffer);
}

test("similarly named unlisted modules are neither captured imports nor trusted implementations", async () => {
  expect(unlistedConstructor(new SharedArrayBuffer(4))).toBeInstanceOf(Int32Array);
  const unlisted = "tests/fixtures/intrinsics.ts";
  const findings = await scanAuthorityProject(root, [
    unlisted,
    "tests/intrinsics-boundary.test.ts",
  ]);
  expect(
    findings.some((finding) => finding.file === unlisted && finding.scope === "unlistedGetter"),
  ).toBe(true);
  expect(
    findings.some(
      (finding) => finding.scope === "unlistedConstructor" && finding.rule === "mutable-builtin",
    ),
  ).toBe(true);
}, 20_000);
