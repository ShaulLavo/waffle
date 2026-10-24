import { FilesystemError } from "../../core/filesystem.js";
import { parseFileIdentity } from "../../fs/file-identity.js";
import { newDir, newSymlink, nodeSize } from "../../fs/memory.js";
import { NamespaceCursor, type NamespaceSource } from "../../fs/namespace-cursor.js";
import { namespaceCut, nodeMetadata } from "../../fs/workspace-protocol.js";

const target = "x".repeat(96);
const link = newSymlink(target);
const root = newDir();
root.children.set("l", link);
const cut = namespaceCut("sizing", { history: "sizing", generation: 1 });
const identity = parseFileIdentity({ id: "10000000000000001", version: "10000000000000001" });
const source: NamespaceSource = {
  root,
  current: () => cut,
  metadata: (node) => ({ ...identity, size: nodeSize(node), mode: node.mode, mtime: node.mtime }),
};

function measure(scenario: string | undefined) {
  if (scenario === "node-size") return { size: nodeSize(link) };
  if (scenario === "protocol-size") {
    try {
      nodeMetadata({ kind: "symlink", target, size: 0 });
      throw new Error("expected size refusal");
    } catch (error) {
      if (!(error instanceof FilesystemError)) throw error;
      return { errno: error.errno };
    }
  }
  if (scenario !== "cursor-pressure") throw new Error("unknown sizing scenario");
  const cursor = new NamespaceCursor(source, {}, undefined, { pageBytes: 256 });
  try {
    return { page: cursor.next(), again: cursor.next(), resources: cursor.resources() };
  } finally {
    cursor.close();
  }
}

const original = TextEncoder.prototype.encode;
const encodedBytes: number[] = [];
TextEncoder.prototype.encode = function (input) {
  const bytes = original.call(this, input);
  if (input === target) encodedBytes.push(bytes.length);
  return bytes;
};
let result: ReturnType<typeof measure>;
try {
  result = measure(Bun.argv[2]);
} finally {
  TextEncoder.prototype.encode = original;
}
console.log(
  JSON.stringify({ result, encodedBytes, restored: TextEncoder.prototype.encode === original }),
);
