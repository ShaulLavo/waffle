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

  test("actual terminal APIs keep private input and stop captures off replaced builtins", async () => {
    const built = await Bun.build({
      entrypoints: [
        resolve(root, "proc/worker-client.ts"),
        resolve(root, "browser/runtime-terminals.ts"),
      ],
      target: "browser",
      format: "cjs",
    });
    expect(built.success).toBe(true);
    const context: Record<string, unknown> = {
      crypto,
      performance,
      setTimeout,
      clearTimeout,
      MessageChannel,
      MessagePort,
      EventTarget,
      Event,
      AbortController,
      TextEncoder,
      TextDecoder,
      processAPI: undefined,
      terminalAPI: undefined,
    };
    for (const output of built.outputs) {
      const exported: unknown = runInNewContext(
        `(function(){const module={exports:{}};${await output.text()};return module.exports;})()`,
        context,
      );
      if (output.path.endsWith("worker-client.js")) context.processAPI = exported;
      if (output.path.endsWith("runtime-terminals.js")) context.terminalAPI = exported;
    }
    const result: unknown = runInNewContext(
      `
      const NativeBytes = Uint8Array;
      let observed = 0;
      const replaced = () => { observed++; throw Error('live terminal builtin reached'); };
      const define = Object.defineProperty;
      const typed = Object.getPrototypeOf(Uint8Array.prototype);
      for (const name of ['buffer','byteOffset','length']) define(typed,name,{configurable:true,get:replaced});
      define(SharedArrayBuffer.prototype,'byteLength',{configurable:true,get:replaced});
      typed.set = replaced;
      typed.subarray = replaced;
      Array.from = replaced;
      Array.prototype.map = replaced;
      Array.prototype.some = replaced;
      Array.prototype[Symbol.iterator] = replaced;
      globalThis.Uint8Array = replaced;
      try { Array.from([]); } catch {}
      if (observed !== 1) throw Error('missing positive canary');
      observed = 0;
      const must = value => { if(value.kind !== 'ok') throw Error(value.code); return value.value; };
      const process = processAPI.createWorkerProcessTransport({capacity:4});
      const input = terminalAPI.createTerminalInput({capacity:4});
      const display = terminalAPI.createTerminalSession({controller:process,geometry:{columns:80,rows:24}});
      const policy = terminalAPI.createTerminalInputPolicy({input});
      const authority = must(terminalAPI.claimTerminalAuthority({identity:display.identity,process,policy,checkActive(){}}));
      const group = must(authority.createGroup({initialMode:'raw'}));
      const member = must(authority.admitExisting({group,pid:process.pid}));
      must(authority.acquire({group,expected:null}));
      const attachment = terminalAPI.attachTerminal({context:member.context,process,policy,checkActive(){}});
      const stream = attachment.resolve(0);
      const bytes = new NativeBytes(3);
      bytes[0]=65; bytes[1]=66; bytes[2]=67;
      if(input.push(bytes)!==3) throw Error('first push failed');
      const first = new NativeBytes(2);
      if(stream.tryRead([first])!==2 || first[0]!==65 || first[1]!==66) throw Error('raw read failed');
      bytes[0]=68; bytes[1]=69; bytes[2]=70;
      if(input.push(bytes)!==3) throw Error('wrapped push failed');
      const wrapped = new NativeBytes(4);
      if(stream.tryRead([wrapped])!==4 || wrapped[0]!==67 || wrapped[3]!==70) throw Error('wrapped read failed');
      must(terminalAPI.terminalControls(stream).setMode({expected:must(display.snapshot()).selection,mode:'cooked'}));
      bytes[0]=65; bytes[1]=13; bytes[2]=10;
      if(must(terminalAPI.pushTerminalInput(display,input,bytes))!==3) throw Error('display push failed');
      const line = new NativeBytes(2);
      if(stream.tryRead([new NativeBytes(0),line])!==2 || line[0]!==65 || line[1]!==10) throw Error('cooked read failed');
      const lifetime = terminalAPI.captureTerminalProcessLifetime({process,terminals:[{identity:display.identity,inputs:[input]}]});
      lifetime.quiesce();
      attachment.dispose();
      display.close('disposed');
      JSON.stringify({observed});
    `,
      context,
    );
    expect(result).toBe('{"observed":0}');
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
      "privateArrayBinding",
      "privateParameterBinding",
      "privateCallbackBinding",
      "privateImportBinding",
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
      "liveTerminalLifetimes",
      "liveTerminalInputs",
      "liveTerminalContexts",
    ])
      expect(rejected.has(name), name).toBe(true);
    for (const name of [
      "captured",
      "indexed",
      "ordinaryPayload",
      "ordinaryArrayBinding",
      "runtimeMethod",
      "plainObjectSpread",
      "harmlessText",
      "ordinaryNamedCall",
      "renamedCaptured",
      "capturedDescriptor",
      "indexedTerminalLifetimes",
    ])
      expect(rejected.has(name), name).toBe(false);
    expect(cases.some((finding) => finding.rule === "mutable-getter")).toBe(true);
    expect(cases.some((finding) => finding.rule === "private-iteration")).toBe(true);
    expect(cases.some((finding) => finding.rule === "species")).toBe(true);
    expect(cases.some((finding) => finding.rule === "native-conversion")).toBe(true);
    expect(cases.some((finding) => finding.rule === "authority-global")).toBe(true);
    expect(enforcedModules).toContain("proc/intrinsics.ts");
    for (const module of [
      "proc/terminal-lifetime.ts",
      "browser/terminal-lifetime.ts",
      "browser/terminal-session.ts",
      "browser/terminal-input.ts",
    ])
      expect(enforcedModules).toContain(module);
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
