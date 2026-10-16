import assert from "node:assert/strict";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { test } from "bun:test";
import { MemFS, adoptInodes } from "../src/fs.ts";

const fsModule = new URL("../src/fs.ts", import.meta.url).href;

async function workerWrite(root, path) {
  // A fresh module realm reproduces the inode counter reset in a browser run worker.
  const source = `
    import { parentPort, workerData } from "node:worker_threads";
    import { MemFS } from ${JSON.stringify(fsModule)};
    const fs = new MemFS(workerData.root);
    fs.mkdirp("/worker-directory");
    fs.writeFile(workerData.path, "worker contents");
    parentPort.postMessage(fs.root);
  `;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), {
    workerData: { root, path },
  });
  try {
    const [result] = await once(worker, "message");
    return result;
  } finally {
    await worker.terminate();
  }
}

function inodeNumbers(root) {
  const numbers = [];
  const walk = (node) => {
    numbers.push(node.ino);
    if (node.kind === "dir") for (const child of node.children.values()) walk(child);
  };
  walk(root);
  return numbers;
}

test("a run worker allocates inodes beyond the inherited filesystem", async () => {
  const fs = new MemFS();
  fs.mkdirp("/existing/directory");
  fs.writeFile("/existing/file", "parent contents");
  const original = inodeNumbers(fs.root);
  const result = await workerWrite(fs.root, "/first-run.txt");
  const numbers = inodeNumbers(result);
  assert.equal(new Set(numbers).size, numbers.length);
  assert.ok(result.children.get("first-run.txt").ino > Math.max(...original));
  assert.equal(result.children.get("existing").ino, fs.root.children.get("existing").ino);
});

test("sequential workers and page edits preserve distinct inode numbers", async () => {
  const fs = new MemFS();
  fs.writeFile("/page-before.txt", "before");
  for (const path of ["/first-run.txt", "/second-run.txt"]) {
    fs.root = await workerWrite(fs.root, path);
    adoptInodes(fs.root); // The page adopts the worker's returned tree before editing it.
    fs.writeFile(`${path}.page`, "page edit");
    const numbers = inodeNumbers(fs.root);
    assert.equal(new Set(numbers).size, numbers.length);
  }
});
