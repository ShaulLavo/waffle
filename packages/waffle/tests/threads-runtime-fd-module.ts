import { call, guestModule, i32, i64, notify, store, wait32 } from "./threads-guest-module.ts";

export type DescriptorCase = "read" | "write";
export const fdLayout = {
  childReady: 0,
  cursorReady: 4,
  childRelease: 8,
  mainRelease: 12,
  spawn: 16,
  first: 256,
  child: 320,
  resumed: 384,
  held: 448,
  replacement: 512,
  after: 576,
} as const;

function checked(instructions: number[]): number[] {
  return instructions.concat([0x04, 0x40, 0x00, 0x0b]);
}
function io(kind: DescriptorCase, fd: number, address: number, length: number): number[] {
  return store(address, i32(address + 32)).concat(
    store(address + 4, i32(length)),
    i32(fd),
    i32(address),
    i32(1),
    i32(address + 8),
    call(kind === "read" ? 1 : 2),
  );
}
function tell(address: number): number[] {
  return checked(i32(4).concat(i32(address), call(4)));
}
function seek(offset: bigint, address: number): number[] {
  return checked(i32(4).concat(i64(offset), i32(1), i32(address), call(3)));
}
function signal(address: number): number[] {
  return store(address, i32(1)).concat(notify(address));
}
function pipe(byte: number, address: number): number[] {
  return store(address + 32, i32(byte)).concat(checked(io("write", 1, address, 1)));
}

export function descriptorModule(selected: DescriptorCase): Uint8Array<ArrayBuffer> {
  const p = fdLayout;
  return guestModule({
    imports: [
      { module: "wasi", name: "thread-spawn", params: [0x7f] },
      { name: "fd_read", params: [0x7f, 0x7f, 0x7f, 0x7f] },
      { name: "fd_write", params: [0x7f, 0x7f, 0x7f, 0x7f] },
      { name: "fd_seek", params: [0x7f, 0x7e, 0x7f, 0x7f] },
      { name: "fd_tell", params: [0x7f, 0x7f] },
      { name: "fd_close", params: [0x7f] },
    ],
    initial: checked(io("read", 4, p.first, 2)).concat(
      tell(p.first + 16),
      store(p.spawn, i32(1).concat(call(0))),
      wait32(p.childReady),
      checked(io("read", 4, p.resumed, 2)),
      tell(p.resumed + 16),
      seek(-9n, p.resumed + 24),
      signal(p.cursorReady),
      store(p.held + 32, i32(0x5655)),
      checked(io(selected, 4, p.held, 2)),
      tell(p.held + 16),
      checked(io("read", 4, p.after, 1)),
      tell(p.after + 16),
      pipe(77, 704),
      wait32(p.mainRelease),
    ),
    secondary: checked(io("read", 4, p.child, 2)).concat(
      tell(p.child + 16),
      seek(1n, p.child + 24),
      store(672, i32(0x7978)),
      checked(io("write", 4, 640, 2)),
      tell(656),
      signal(p.childReady),
      wait32(p.cursorReady),
      checked(io("read", 0, 768, 1)),
      pipe(80, 832),
      checked(i32(4).concat(call(5))),
      tell(p.replacement + 16),
      checked(io("read", 4, p.replacement, 2)),
      store(928, i32(81)),
      checked(io("write", 4, 896, 1)),
      tell(912),
      pipe(82, 960),
      wait32(p.childRelease),
    ),
  });
}
