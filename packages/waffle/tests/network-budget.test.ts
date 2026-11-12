import { describe, expect, test } from "bun:test";
import { loadNetworkModule } from "../browser/net/module.js";
import { loadBufferNetworkModule } from "../browser/net/buffer-module.js";

const MIB = 1 << 20;
for (const [form, load] of Object.entries({
  wasm: loadNetworkModule,
  buffer: loadBufferNetworkModule,
})) {
  describe(form, () => {
    test("shared quota counts retained halves, refuses without a port, and reuses all metadata", async () => {
      const owner = (await load()).create();
      try {
        const pairs = Array.from({ length: 256 }, () => owner.call("net_pair"));
        expect(pairs.every((id) => id > 0)).toBe(true);
        expect(owner.call("net_pair")).toBe(-17);
        const port = owner.call("net_listen", 4, 12345);
        expect(owner.call("net_connect", 4, port)).toBe(-17);
        const first = pairs[0];
        if (first === undefined) throw Error("Missing first pair");
        const peer = owner.call("net_peer", first);
        owner.call("net_close", first);
        expect(owner.call("net_usage", 0)).toBe(512);
        expect(owner.call("net_pair")).toBe(-17);
        owner.call("net_close", peer);
        const client = owner.call("net_connect", 4, port);
        expect(client).toBeGreaterThan(0);
        expect(new DataView(owner.address(client).buffer).getUint32(4, true)).toBe(49152);
        expect(owner.call("net_usage", 0)).toBe(512);
      } finally {
        owner.dispose();
      }
    });

    test("listener equality, crossing and release preserve independent quota", async () => {
      const owner = (await load()).create();
      try {
        for (let port = 1000; port < 2024; port++)
          expect(owner.call("net_listen", 4, port)).toBe(port);
        expect(owner.call("net_listen", 4, 2024)).toBe(-17);
        expect(owner.call("net_usage", 1)).toBe(1024);
        owner.call("net_unlisten", 1234);
        expect(owner.call("net_listen", 4, 2024)).toBe(2024);
        expect(owner.call("net_pair")).toBeGreaterThan(0);
      } finally {
        owner.dispose();
      }
    });

    test("over-reported consumption preserves packet order, queue cap and readiness", async () => {
      const owner = (await load()).create();
      try {
        const client = owner.call("net_pair"),
          peer = owner.call("net_peer", client);
        const packet = Uint8Array.from({ length: owner.capacity }, (_, index) => index % 251);
        for (let index = 0; index < 16; index++)
          expect(owner.write("net_write", client, packet)).toBe(packet.length);
        expect(owner.call("net_consumed", peer, 0xffffffff)).toBe(0);
        expect(owner.call("net_writable", client)).toBe(0);
        expect(owner.write("net_write", client, packet)).toBe(-1);
        expect(owner.read("net_take", peer, packet.length)).toEqual(packet);
        expect(owner.call("net_writable", client)).toBe(0);
        expect(owner.call("net_consumed", peer, 0xffffffff)).toBe(1);
        expect(owner.call("net_writable", client)).toBe(1);
        const tail = new Uint8Array(packet.length).fill(254);
        expect(owner.write("net_write", client, tail)).toBe(tail.length);
        expect(owner.call("net_writable", client)).toBe(0);
        for (let index = 0; index < 15; index++)
          expect(owner.read("net_take", peer, packet.length)).toEqual(packet);
        expect(owner.read("net_take", peer, packet.length)).toEqual(tail);
        expect(owner.call("net_consumed", peer, MIB)).toBe(1);
        owner.call("net_close", client);
        owner.call("net_close", peer);
        const reused = owner.call("net_pair");
        expect(owner.write("net_write", reused, tail)).toBe(tail.length);
      } finally {
        owner.dispose();
      }
    });

    test("duplicate close of a retained token cannot release a newer client's wrapped port", async () => {
      const owner = (await load()).create();
      try {
        owner.call("net_listen", 4, 12345);
        const old = owner.call("net_connect", 4, 12345);
        owner.call("net_close", old);
        for (let index = 0; index < 16383; index++) {
          const client = owner.call("net_connect", 4, 12345),
            peer = owner.call("net_peer", client);
          owner.call("net_close", client);
          owner.call("net_close", peer);
        }
        const current = owner.call("net_connect", 4, 12345);
        expect(new DataView(owner.address(current).buffer).getUint32(4, true)).toBe(49152);
        owner.call("net_close", old);
        expect(owner.call("net_listen", 4, 49152)).toBe(-3);
        expect(owner.write("net_write", current, new Uint8Array([42]))).toBe(1);
      } finally {
        owner.dispose();
      }
    });
  });
}
