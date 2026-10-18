import { expect, test } from "bun:test";
import { MemFS } from "../fs/memory.ts";
import { GuestIO, guestFixture } from "../tooling/vfs-guest.ts";
import { withStrictDecoder } from "./fixtures/buffer-boundaries.ts";

test("guest readdir snapshots resizable guest memory before decoding names", async () => {
  const guest = new GuestIO(new MemFS(), new WebAssembly.Module(guestFixture()));
  try {
    const memory = (guest as unknown as { bytes: Uint8Array }).bytes;
    expect(Reflect.get(memory.buffer, "resizable")).toBe(true);
    await guest.mkdir("/names");
    await guest.write("/names/café", new Uint8Array());
    await guest.write("/names/日本語", new Uint8Array());
    let names: Promise<string[]> | undefined;
    let inputs: readonly ArrayBufferLike[] = [];
    withStrictDecoder(backings => {
      names = guest.readdir("/names");
      inputs = backings;
    });
    expect(await names).toEqual(["café", "日本語"]);
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.every(buffer => !Reflect.get(buffer, "resizable") && !Reflect.get(buffer, "growable"))).toBe(true);
    expect(inputs.every(buffer => buffer !== memory.buffer)).toBe(true);
  } finally {
    guest.dispose();
  }
});
