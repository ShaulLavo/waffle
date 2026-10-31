import { compileInterruptible } from "../interrupt/loader.js";
import {
  ADMITTED_CACHE_PREFIX,
  ADMITTED_DIGEST_HEADER,
  admittedKey,
  interruptTransformId,
  programStage,
  sha256Hex,
} from "../interrupt/admitted-store.js";
import { interruptLoopFixture } from "./fixtures/interrupt-browser-loops.js";
import { cancellation } from "./interrupt-browser.js";
import { cleanInterruptWorkers, until } from "./interrupt-browser-control.js";
import { Wasi } from "../core/wasi.js";
import { MemFS } from "../fs/memory.js";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function source(): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch("/ls.wasm");
  check(response.ok, `ls fixture HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function runLs(module: WebAssembly.Module) {
  const fs = new MemFS();
  fs.mkdirp("/work");
  fs.writeFile("/work/fixture.txt", new TextEncoder().encode("persistent cache control"));
  let stdout = "",
    stderr = "";
  const wasi = new Wasi({
    args: ["ls", "/work"],
    env: {},
    sleep: () => {
      throw new Error("ls unexpectedly slept");
    },
    fs,
    preopens: { "/": "/" },
    namespaces: { runtime_proc: { __waffle_fatal: () => 0 } },
    stdout: (bytes) => {
      stdout += new TextDecoder().decode(bytes);
    },
    stderr: (bytes) => {
      stderr += new TextDecoder().decode(bytes);
    },
  });
  const code = wasi.start(new WebAssembly.Instance(module, wasi.imports(module)));
  check(code === 0 && stdout.includes("fixture.txt"), `ls failed ${code}: ${stderr}`);
  return { code, stdout, stderr };
}

async function load(cancel: boolean) {
  performance.clearMeasures();
  const start = performance.now();
  const bytes = await source();
  const end = performance.now();
  programStage("source", start, { bytes: bytes.length }, end);
  const module = await compileInterruptible(bytes);
  const output = runLs(module);
  const outputMs = performance.now() - start;
  const loop = await compileInterruptible(interruptLoopFixture());
  const interrupted = cancel ? await cancellation(loop, "tight-backedge", 2, 0) : null;
  const admissions = performance.getEntriesByName("waffle:program:admit").length;
  if (admissions)
    await until(
      () => performance.getEntriesByName("waffle:program:store-put").length === admissions,
      "admitted puts",
    );
  return {
    ...output,
    outputMs,
    interrupted,
    stages: performance
      .getEntriesByType("measure")
      .filter((entry) => entry.name.startsWith("waffle:program:"))
      .map((entry) => ({
        name: entry.name,
        duration: entry.duration,
        detail: entry instanceof PerformanceMeasure ? entry.detail : null,
      })),
    fetches: performance
      .getEntriesByType("resource")
      .filter((entry) => entry.name.endsWith("/ls.wasm"))
      .map((entry) => ({
        name: entry.name,
        transferSize: entry instanceof PerformanceResourceTiming ? entry.transferSize : null,
      })),
    cacheNames: await caches.keys(),
  };
}

async function clear() {
  await caches.delete(ADMITTED_CACHE_PREFIX + interruptTransformId());
}

async function tamper(kind: "raw" | "digest" | "malformed") {
  const bytes = await source();
  const key = admittedKey(location.origin, await sha256Hex(bytes));
  const cache = await caches.open(ADMITTED_CACHE_PREFIX + interruptTransformId());
  const body = kind === "malformed" ? new Uint8Array([0, 1]) : bytes;
  const digest = kind === "digest" ? "0".repeat(64) : await sha256Hex(body);
  await cache.put(
    key,
    new Response(body, {
      headers: {
        "content-type": "application/wasm",
        "content-length": String(body.length),
        [ADMITTED_DIGEST_HEADER]: digest,
      },
    }),
  );
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("waffle-trim5-module-clone", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("modules");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function persistModuleControl() {
  const db = await database();
  try {
    const module = await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("modules", "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.objectStore("modules").put(module, "empty");
    });
    return { stored: true };
  } catch (error) {
    return { stored: false, error: String(error) };
  } finally {
    db.close();
  }
}

async function readModuleControl() {
  const db = await database();
  try {
    const value: unknown = await new Promise((resolve, reject) => {
      const request = db.transaction("modules").objectStore("modules").get("empty");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return {
      module: value instanceof WebAssembly.Module,
      imports: value instanceof WebAssembly.Module ? WebAssembly.Module.imports(value) : null,
    };
  } finally {
    db.close();
  }
}

/** @browserEntry */
export const admittedHarness = {
  load,
  clear,
  tamper,
  persistModuleControl,
  readModuleControl,
  clean: cleanInterruptWorkers,
};
