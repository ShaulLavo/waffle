import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { verifyWasiGuest } from "./program-build-tools.ts";

const integer = (value: number): number[] => {
  const bytes: number[] = [];
  do {
    const part = value & 127;
    value >>>= 7;
    bytes.push(part | (value ? 128 : 0));
  } while (value);
  return bytes;
};
const text = (value: string) =>
  integer(value.length).concat(Array.from(new TextEncoder().encode(value)));
const section = (kind: number, body: number[]) => [kind].concat(integer(body.length), body);

// Original minimal modules for the verifier only; production artifacts are also
// inspected by every family build entrypoint. The disassembler is a controlled stand-in.
function moduleBytes(maximum: number, withNames = true, adapter = "") {
  const imports = [2].concat(
    ...["fd_prestat_get", "fd_fdstat_get"].map((name) =>
      text("wasi_snapshot_preview1").concat(text(name), [0, 0]),
    ),
  );
  const names = adapter
    ? [2].concat([0], text(`${adapter}::fd_prestat_get`), [1], text(`${adapter}::fd_fdstat_get`))
    : [3].concat(
        [0],
        text("__wasi_fd_prestat_get"),
        [1],
        text("__wasi_fd_fdstat_get"),
        [2],
        text("__wasilibc_populate_preopens"),
      );
  return new Uint8Array(
    [0, 97, 115, 109, 1, 0, 0, 0].concat(
      section(1, [1, 0x60, 0, 0]),
      section(2, imports),
      section(3, [1, 0]),
      section(5, [1, 1, 1].concat(integer(maximum))),
      section(10, [1, 6, 0, 0x10, 0, 0x10, 1, 0x0b]),
      withNames ? section(0, text("name").concat(section(1, names))) : [],
    ),
  );
}

function fixture(
  run: (path: string, sdk: string, setDisassembly: (text: string) => void) => void,
  maximum = 4096,
) {
  const parent = resolve(import.meta.dirname, "../.build");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(resolve(parent, "wasi-verifier-test-"));
  try {
    mkdirSync(resolve(root, "bin"));
    const path = resolve(root, "guest.wasm");
    writeFileSync(path, moduleBytes(maximum));
    const tool = resolve(root, "bin/llvm-objdump");
    const setDisassembly = (text: string) => {
      writeFileSync(tool, `#!/bin/bash\nprintf '%s\\n' '${text}'\n`);
      chmodSync(tool, 0o755);
    };
    setDisassembly("  call 0\n  call 1\n");
    run(path, root, setDisassembly);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("verifier accepts scanner code containing both probes and capped memory", () => {
  fixture((path, sdk) => verifyWasiGuest(path, { sdk }));
});

test("an fdstat import alone does not prove the scanner was patched", () => {
  fixture((path, sdk, setDisassembly) => {
    setDisassembly("  call 0\n  call 11\n");
    assert.throws(
      () => verifyWasiGuest(path, { sdk }),
      /scanner does not call __wasi_fd_fdstat_get/,
    );
  });
});

test("verifier rejects final guest memory cap drift", () => {
  fixture((path, sdk) => {
    assert.throws(() => verifyWasiGuest(path, { sdk }), /guest memory cap changed/);
  }, 65536);
});

for (const [description, limits] of [
  ["uncapped", [0, 1]],
  ["512 MiB", [1, 1].concat(integer(8192))] as const,
] as const) {
  test(`verifier rejects an additional ${description} imported memory`, () => {
    fixture((path, sdk) => {
      const bytes = new Uint8Array(
        [0, 97, 115, 109, 1, 0, 0, 0].concat(
          section(2, [1].concat(text("env"), text("extraMemory"), [2], limits)),
          section(5, [1, 1, 1].concat(integer(4096))),
        ),
      );
      assert.ok(WebAssembly.validate(bytes), "control must be a valid Wasm module");
      writeFileSync(path, bytes);
      assert.throws(() => verifyWasiGuest(path, { sdk }), /guest memory must not be imported/);
    });
  });
}

test("deadstripped libc is accepted only when no filesystem imports remain", () => {
  fixture((path, sdk) => {
    writeFileSync(
      path,
      new Uint8Array(
        [0, 97, 115, 109, 1, 0, 0, 0].concat(section(5, [1, 1, 1].concat(integer(4096)))),
      ),
    );
    verifyWasiGuest(path, { sdk });
    writeFileSync(path, moduleBytes(4096, false));
    assert.throws(
      () => verifyWasiGuest(path, { sdk }),
      /filesystem imports remain but libc scanner is missing/,
    );
  });
});

test("direct Rust adapter imports prove scanner omission without hiding libc", () => {
  fixture((path, sdk) => {
    const filesystemAdapter = "waffle_program_support::runtime::wasi";
    writeFileSync(path, moduleBytes(4096, true, filesystemAdapter));
    verifyWasiGuest(path, { sdk, filesystemAdapter });
    assert.throws(
      () =>
        verifyWasiGuest(path, {
          sdk,
          filesystemAdapter: "another_program::runtime::wasi",
        }),
      /filesystem imports remain but libc scanner is missing/,
    );
  });
});
