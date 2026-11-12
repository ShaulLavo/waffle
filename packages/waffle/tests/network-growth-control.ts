import assert from "node:assert/strict";
import { networkGrowth, traceNetworkGrowth } from "../tooling/network-growth.js";
import { instantiate } from "../browser/net/network.buffer.js";

const form = process.argv[2];
const trace =
  form === "wasm"
    ? await networkGrowth(
        new Uint8Array(
          await Bun.file(new URL("../browser/net/network.wasm", import.meta.url)).arrayBuffer(),
        ),
      )
    : (() => {
        const exports = instantiate({ waffle_tcp_host: { io: () => -10 } });
        return traceNetworkGrowth(exports, exports.memory);
      })();
assert.equal(trace.growthPages.length, 136);
console.log(JSON.stringify({ form, ...trace }));
