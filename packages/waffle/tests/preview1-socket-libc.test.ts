import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { socketGuest, scriptedSocket, bytes } from "./preview1-socket-support.js";
import { runOwned } from "../scripts/owned-command.js";

const sdk = process.env.WASI_SDK_PATH ?? "/work/cache/wasm-tools/wasi-sdk";
const sysroot =
  process.env.WASI_LIBC_SYSROOT_CACHE ?? "/work/cache/wasm-tools/bun-wasm-sysroot-patched";
const cached =
  process.env.WAFFLE_LIBC_FIXTURES && join(process.env.WAFFLE_LIBC_FIXTURES, "socket.wasm");
if (cached && !existsSync(cached)) throw Error("The libc fixture producer must build socket.wasm");
const available =
  !!cached ||
  (existsSync(join(sdk, "bin/clang")) && existsSync(join(sysroot, "lib/wasm32-wasip1/libc.a")));
let scratch: string | undefined;
let module: WebAssembly.Module;

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});
beforeAll(async () => {
  if (!available) return;
  let fixture = cached;
  if (!fixture) {
    scratch = mkdtempSync(
      join(process.env.WASI_LIBC_SCRATCH_ROOT ?? "/work/tmp", "waffle-n4-libc-"),
    );
    fixture = join(scratch, "socket.wasm");
    await runOwned(
      [
        join(sdk, "bin/clang"),
        "--target=wasm32-wasip1",
        `--sysroot=${sysroot}`,
        "-O2",
        new URL("./fixtures/preview1-socket.c", import.meta.url).pathname,
        "-o",
        fixture,
      ],
      { cwd: import.meta.dir, env: process.env },
    );
  }
  module = new WebAssembly.Module(await Bun.file(fixture).arrayBuffer());
});

for (const nonblocking of [false, true])
  test.skipIf(!available)(
    `C socket I/O and moved preopen work with nonblocking=${nonblocking}`,
    async () => {
      const stream = scriptedSocket(false, true);
      const guest = await socketGuest({
        module,
        interactive: false,
        args: nonblocking ? ["socket", "3", "nonblock"] : ["socket", "3"],
        connect: async () => stream.stream,
      });
      try {
        expect(await guest.exit).toMatchObject({ type: "exit", code: 0 });
        expect(Buffer.concat(guest.output).toString()).toBe("waffle echo\n");
        expect(stream.writes).toEqual([bytes("waffle echo\n")]);
      } finally {
        await guest.close();
      }
    },
  );
