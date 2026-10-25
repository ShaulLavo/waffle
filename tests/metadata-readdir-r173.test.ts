import { expect, test } from "bun:test";
import { MemoryBackend } from "../fs/backend.js";
import type { FilesystemService } from "../fs/service.js";
import { State } from "../fs/protocol.js";
import { MemFS } from "../fs/memory.js";
import { DirectoryPages } from "../fs/directory-pages.js";
import type { FileHandle } from "../core/filesystem.js";
import { metadataWorker } from "./fixtures/metadata-enumeration-r173-service.js";
import { enumerateDirectory } from "./fixtures/metadata-enumeration-r173-wasi.js";

class CountedDirectory extends MemFS {
  listCalls = 0;
  materialized = 0;
  readdir(handle: FileHandle) {
    const result = super.readdir(handle);
    this.listCalls++;
    this.materialized += result.length;
    return result;
  }
}

function indexCounter(pages: DirectoryPages) {
  const counters = { steps: 0 };
  const root = pages["root"];
  function visit(branch: typeof root): void {
    if (!branch) return;
    const left = branch.left,
      right = branch.right;
    visit(left);
    visit(right);
    Object.defineProperty(branch, "left", {
      get() {
        counters.steps++;
        return left;
      },
    });
    Object.defineProperty(branch, "right", {
      get() {
        counters.steps++;
        return right;
      },
    });
  }
  visit(root);
  return counters;
}

function countTransport(
  service: FilesystemService,
  counters: { responseCalls: number; responseBytes: number; serializedListBytes: number },
) {
  const write = service["writeResponse"].bind(service);
  service["writeResponse"] = (...args) => {
    const state = write(...args);
    if (Array.isArray(args[4])) counters.serializedListBytes += args[2][2]!;
    if (state === State.Complete && (Array.isArray(args[4]) || args[4] instanceof Uint8Array)) {
      counters.responseCalls++;
      counters.responseBytes += args[2][2]!;
    }
    return state;
  };
}

async function directoryRun(count: number) {
  const fs = new CountedDirectory();
  const expected = [".", ".."].concat(
    Array.from({ length: count }, (_, index) => `entry-${String(index).padStart(5, "0")}`),
  );
  for (const name of expected.slice(2)) fs.writeFile(`/${name}`, "");
  const index = indexCounter(fs["directoryPages"](fs.root));
  const entriesAfter = DirectoryPages.prototype.entriesAfter;
  DirectoryPages.prototype.entriesAfter = function* (cookie: bigint) {
    for (const entry of entriesAfter.call(this, cookie)) {
      fs.materialized++;
      yield entry;
    }
  };
  const backend = new MemoryBackend(fs);
  const transport = { responseCalls: 0, responseBytes: 0, serializedListBytes: 0 };
  const run = metadataWorker<ReturnType<typeof enumerateDirectory>>(
    backend,
    { scenario: "directory", count },
    (service) => countTransport(service, transport),
  );
  const result = await run.finally(() => {
    DirectoryPages.prototype.entriesAfter = entriesAfter;
  });
  const counters = {
    count,
    guestCalls: result.calls,
    fullLists: fs.listCalls,
    materialized: fs.materialized,
    indexSteps: index.steps,
    ...transport,
  };
  console.log("readdir counters", counters);
  expect(result).not.toHaveProperty("error");
  expect(result.names).toEqual(expected);
  expect(result.cookies).toEqual(
    Array.from({ length: count + 2 }, (_, index) => BigInt(index + 1)),
  );
  expect(new Set(result.names).size).toBe(count + 2);
  expect(result.partialPages).toBeGreaterThan(0);
  expect(result.partial).toBe(10);
  expect(result.eof).toBe(0);
  expect(result.restart).toEqual(expected.slice(0, result.restart.length));
  return { result, counters };
}

test("#118 real Worker WASI consumer resumes every complete cookie, retries partial records and reaches EOF", async () => {
  await directoryRun(1000);
});

for (const count of [1000, 10000]) {
  test(`#118 ${count} entries materialize and transport only returned directory pages`, async () => {
    const { result, counters } = await directoryRun(count);
    // Includes EOF probes, a partial-header probe and one explicit rewind page.
    const budget = count + 2 + 256 + result.calls * 2;
    expect(counters.materialized).toBeGreaterThanOrEqual(count);
    expect({
      boundedIndex: counters.indexSteps <= count * 4 + result.calls * 64,
      boundedMaterialization: counters.materialized <= budget,
      boundedTransport: counters.responseBytes <= budget * 100,
    }).toEqual({ boundedIndex: true, boundedMaterialization: true, boundedTransport: true });
  });
}
