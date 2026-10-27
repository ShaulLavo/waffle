import { expect, test } from "bun:test";
import { relative, resolve } from "node:path";
import { runInNewContext } from "node:vm";

import * as Intrinsics from "../proc/intrinsics.ts";
import * as CoreIntrinsics from "../proc/intrinsics/core.ts";
import * as HostIntrinsics from "../proc/intrinsics/host.ts";
import { ProcessError, ProcessErrno } from "../proc/errors.ts";
import { ProcessError as TypesError, ProcessErrno as TypesErrno } from "../proc/types.ts";
import { ProcessError as PublicError, ProcessErrno as PublicErrno } from "../proc/index.ts";
import { FilesystemSection, isRevoked } from "../fs/section.js";
import {
  FilesystemSection as ProtocolSection,
  isRevoked as protocolRevoked,
} from "../fs/protocol.js";

const root = resolve(import.meta.dir, "..");

test("full core omits unrelated host captures, signal constants and publication initialization", async () => {
  const built = await Bun.build({
    entrypoints: [resolve(root, "core/index.ts")],
    target: "browser",
    format: "cjs",
    metafile: true,
  });
  expect(built.success).toBe(true);
  if (!built.metafile) throw new Error("missing full-core metadata");
  const inputs = Object.keys(built.metafile.inputs).map((path) => relative(root, resolve(path)));
  for (const path of ["proc/intrinsics.ts", "proc/types.ts", "fs/protocol.ts", "fs/publication.ts"])
    expect(inputs).not.toContain(path);
  const output = built.outputs[0];
  if (!output) throw new Error("missing full-core output");
  const source = await output.text();
  for (const initializer of ["randomUUID", "DataView.prototype", "SIGRTMAX"])
    expect(source.includes(initializer), initializer).toBe(false);
  const context = {
    module: { exports: {} },
    performance,
    TextEncoder,
    TextDecoder,
    crypto: {
      getRandomValues: crypto.getRandomValues.bind(crypto),
      get randomUUID() {
        return unrelatedCapture();
      },
    },
  };
  for (const name of ["setTimeout", "SharedArrayBuffer"])
    Object.defineProperty(context, name, { get: unrelatedCapture });
  runInNewContext(source, context);
});

test("intrinsic barrel reexports the original capture and helper identities", () => {
  const exported = new Map<string, unknown>(Object.entries(Intrinsics));
  const coreEntries: [string, unknown][] = Object.entries(CoreIntrinsics);
  const leaves = coreEntries.concat(Object.entries(HostIntrinsics));
  expect(exported.size).toBe(leaves.length - 1);
  for (const [name, value] of leaves) {
    if (name === "descriptor") continue;
    expect(exported.get(name), name).toBe(value);
  }
});

test("error and filesystem reexports preserve constructor and function identity", () => {
  expect(TypesError).toBe(ProcessError);
  expect(PublicError).toBe(ProcessError);
  expect(TypesErrno).toBe(ProcessErrno);
  expect(PublicErrno).toBe(ProcessErrno);
  expect(Object.isFrozen(ProcessErrno)).toBe(true);
  expect(ProtocolSection).toBe(FilesystemSection);
  expect(protocolRevoked).toBe(isRevoked);
});

function unrelatedCapture(): never {
  throw new Error("unrelated host capability initialized by core");
}

for (const source of ["promoted", "imported"]) {
  test(`repeated ${source} filesystem exports avoid the mutable buffer getter`, async () => {
    const child = Bun.spawn(
      [process.execPath, resolve(root, "tests/fixtures/intrinsics.ts"), source],
      { stdout: "pipe", stderr: "pipe" },
    );
    try {
      const output = await new Response(child.stderr).text();
      expect(await child.exited, output).toBe(0);
    } finally {
      child.kill();
      await child.exited;
    }
  });
}
