import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import type { LinkPlanSource } from "../link/index.js";

const inputs = [
  ["manifest.json", "fc178cb4ed9ab30bfcffbda5e4d14d6778f43c079152ec30f4d370078a33bb29"],
  ["core/bun-core.wasm", "604af35350c780fe55980e8c5e15f3eab3a9937161e0ca36da4ac011443b7c38"],
  ["quickjs/engine.wasm", "9a5d37abe1c79fefbab6f206d85997f7366835fd59479ecd0766ce81b37cc78e"],
] as const;

export async function verifiedInputs(directory: string) {
  const bytes: Uint8Array[] = [];
  const originals = [];
  for (const [path, expected] of inputs) {
    const file = `${directory}/${path}`;
    const before = await stat(file);
    const data = await Bun.file(file).bytes();
    const hash = createHash("sha256").update(data).digest("hex");
    if (hash !== expected) throw new Error(`immutable fixture hash mismatch: ${path}`);
    bytes.push(data);
    originals.push({ path, hash, size: before.size, nlink: before.nlink, mtimeMs: before.mtimeMs });
  }
  return { originals, core: bytes[1]!, side: bytes[2]! };
}

export function sharedSource(core: Uint8Array, side: Uint8Array): LinkPlanSource {
  return {
    core: {
      id: "bun-core",
      source: core,
      cooperative: true,
      checkpoint: { module: "runtime_proc", name: "signal" },
      initializeMemory: ["core_initialize_memory", "__wasm_apply_data_relocs"],
      initialize: ["__wasm_call_ctors"],
    },
    libraries: [
      {
        id: "quickjs",
        source: side,
        cooperative: true,
        checkpoint: { module: "env", name: "core_checkpoint" },
        initializeMemory: ["quickjs_initialize_memory", "quickjs_apply_data_relocs"],
        initialize: ["quickjs_call_ctors", "quickjs_register"],
      },
    ],
    reserve: "bun_core_alloc",
  };
}
