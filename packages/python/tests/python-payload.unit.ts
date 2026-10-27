import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test, type TestContext } from "node:test";
type Entry =
  | { kind: "file" | "symlink"; ino: number; mtime: number; target?: string }
  | { kind: "dir"; ino: number; mtime: number; children: Map<string, Entry> };
type WriteFileMode = boolean | { exclusive?: boolean };
import {
  createPythonPayload,
  PYTHON_ARGV0,
  type PythonPayloadManifest,
} from "../src/python-payload.ts";

const wasm = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
const encode = (text: string) => new TextEncoder().encode(text);
const data = new Map([
  ["/Lib/os.py", encode("# os\n")],
  ["/Lib/empty.py", encode("")],
  ["/cross-build/wasm32-wasip1/pybuilddir.txt", encode("build/lib.wasi-wasm32-3.15")],
]);
const metadata: PythonPayloadManifest = {
  format: 1,
  cpython: "5e58eaad7c58df58dfa8ea549c87996e01dd1077",
  argv0: PYTHON_ARGV0,
  files: Array.from(data, ([path, bytes]) => ({
    path,
    url: `https://assets.test/files${path}`,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  })),
};

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function message(error: unknown): string {
  if (error instanceof AggregateError) return error.message + error.errors.map(message).join(" ");
  return error instanceof Error ? error.message : String(error);
}

function fixture(context: TestContext) {
  const files = new Map<string, Uint8Array>();
  const entries = new Map<string, Entry>();
  const fetched: string[] = [];
  const calls: string[] = [];
  const removed: string[] = [];
  let fetchedManifest: unknown = metadata;
  let fetchHook: (url: string) => Promise<void> = async () => {};
  let writeHook: (path: string) => Promise<void> = async () => {};
  let drainHook = async () => {};
  const runtime = {
    disposed: false,
    filesystem: {
      async lookup(path: string): Promise<Entry | undefined> {
        calls.push(`lookup:${path}`);
        if (files.has(path)) return { kind: "file", ino: 1, mtime: 0 };
        return entries.get(path);
      },
      async readFile(path: string) {
        calls.push(`read:${path}`);
        return files.get(path);
      },
      async mkdirp(path: string) {
        calls.push(`mkdir:${path}`);
        const parts = path.slice(1).split("/");
        parts.forEach((_, index) =>
          entries.set("/" + parts.slice(0, index + 1).join("/"), {
            kind: "dir",
            ino: 1,
            mtime: 0,
            children: new Map(),
          }),
        );
      },
      async writeFile(path: string, bytes: string | Uint8Array, mode: WriteFileMode = false) {
        calls.push(`write:${path}`);
        assert.ok(typeof mode === "object" && mode.exclusive);
        await writeHook(path);
        if (files.has(path) || entries.has(path)) throw new Error(`EEXIST: ${path}`);
        files.set(path, typeof bytes === "string" ? encode(bytes) : bytes.slice());
      },
      async remove(path: string) {
        calls.push(`remove:${path}`);
        removed.push(path);
        return files.delete(path);
      },
      async drain() {
        calls.push("drain");
        await drainHook();
      },
    },
  };
  const previous = globalThis.fetch;
  const fetchMock = Object.assign(async (input: RequestInfo | URL) => {
    const url = String(input);
    fetched.push(url);
    await fetchHook(url);
    if (url.endsWith("manifest.json")) return Response.json(fetchedManifest);
    const path = new URL(url).pathname.replace(/^\/files/, "");
    const bytes = data.get(path);
    return bytes ? new Response(bytes) : new Response(null, { status: 404 });
  }, { preconnect() {} });
  globalThis.fetch = fetchMock;
  const payload = createPythonPayload(runtime, { payloadUrl: "https://assets.test/manifest.json" });
  context.after(async () => {
    try {
      await payload.dispose();
    } finally {
      globalThis.fetch = previous;
    }
  });
  return {
    runtime,
    files,
    entries,
    fetched,
    calls,
    removed,
    payload,
    manifest(value: unknown) {
      fetchedManifest = value;
    },
    fetch(hook: typeof fetchHook) {
      fetchHook = hook;
    },
    write(hook: typeof writeHook) {
      writeHook = hook;
    },
    drain(hook: typeof drainHook) {
      drainHook = hook;
    },
  };
}

test("Python payload is quiet until use, shares first use, and drains before returning raw bytes", async (context) => {
  const state = fixture(context);
  assert.equal(state.calls.length + state.fetched.length, 0);
  const draining = deferred();
  const entered = deferred();
  state.drain(async () => {
    entered.resolve();
    await draining.promise;
  });
  let resolved = false;
  let loads = 0;
  const source = async () => {
    loads++;
    return wasm;
  };
  const first = state.payload.load(source);
  assert.equal(state.payload.load(source), first);
  void first.then(() => {
    resolved = true;
  });
  await entered.promise;
  assert.equal(resolved, false);
  assert.equal(state.files.size, data.size);
  draining.resolve();
  assert.equal(await first, wasm);
  assert.equal(loads, 1);
  assert.equal(state.fetched.length, data.size + 1);
  assert.equal(state.files.get("/Lib/empty.py")?.length, 0);
});

test("identical borrowed files and modified files survive disposal, created unchanged files do not", async (context) => {
  const state = fixture(context);
  state.files.set("/Lib/os.py", data.get("/Lib/os.py")!);
  await state.payload.load(async () => wasm);
  state.files.set("/Lib/empty.py", encode("caller edit"));
  state.files.set("/Lib/__pycache__/caller.pyc", encode("caller cache"));
  const first = state.payload.dispose();
  assert.equal(state.payload.dispose(), first);
  await first;
  assert.deepEqual(Array.from(state.files.keys()).sort(), [
    "/Lib/__pycache__/caller.pyc",
    "/Lib/empty.py",
    "/Lib/os.py",
  ]);
  assert.deepEqual(state.removed, ["/cross-build/wasm32-wasip1/pybuilddir.txt"]);
  assert.ok(state.entries.has("/Lib"));
  await assert.rejects(
    state.payload.load(async () => wasm),
    /disposed/,
  );
});

for (const kind of ["foreign file", "directory", "symlink", "parent file", "parent symlink"]) {
  test(`payload rejects a ${kind} without overwriting it`, async (context) => {
    const state = fixture(context);
    if (kind === "foreign file") state.files.set("/Lib/os.py", encode("foreign"));
    if (kind === "directory")
      state.entries.set("/Lib/os.py", { kind: "dir", ino: 2, mtime: 0, children: new Map() });
    if (kind === "symlink")
      state.entries.set("/Lib/os.py", { kind: "symlink", ino: 2, mtime: 0, target: "/foreign" });
    if (kind === "parent file") state.files.set("/Lib", encode("foreign"));
    if (kind === "parent symlink")
      state.entries.set("/Lib", { kind: "symlink", ino: 2, mtime: 0, target: "/foreign" });
    const before = Array.from(state.files);
    await assert.rejects(
      state.payload.load(async () => wasm),
      /collision/,
    );
    assert.deepEqual(Array.from(state.files), before);
    assert.equal(state.removed.includes("/Lib/os.py"), false);
  });
}

const invalidManifests: Array<[string, unknown]> = [
  [
    "symlink metadata",
    {
      ...metadata,
      files: metadata.files.map((file) => ({ ...file, kind: "symlink", target: "/foreign" })),
    },
  ],
  ["source identity", { ...metadata, cpython: "foreign" }],
  ["argv0", { ...metadata, argv0: "python" }],
  ["format", { ...metadata, format: 2 }],
  ["missing required marker", { ...metadata, files: metadata.files.slice(0, 1) }],
  ["duplicate", { ...metadata, files: metadata.files.concat(metadata.files[0]!) }],
  [
    "traversal",
    {
      ...metadata,
      files: metadata.files.concat({ ...metadata.files[0]!, path: "/Lib/../foreign" }),
    },
  ],
  [
    "unexpected root",
    { ...metadata, files: metadata.files.concat({ ...metadata.files[0]!, path: "/bin/foreign" }) },
  ],
  [
    "noncanonical",
    { ...metadata, files: metadata.files.concat({ ...metadata.files[0]!, path: "/Lib//foreign" }) },
  ],
  [
    "directory entry",
    { ...metadata, files: metadata.files.concat({ ...metadata.files[0]!, path: "/Lib/dir/" }) },
  ],
  [
    "bad hash",
    {
      ...metadata,
      files: metadata.files.concat({ ...metadata.files[0]!, path: "/Lib/new.py", sha256: "123" }),
    },
  ],
  [
    "unsafe size",
    {
      ...metadata,
      files: metadata.files.concat({ ...metadata.files[0]!, path: "/Lib/new.py", bytes: -1 }),
    },
  ],
  [
    "file as directory",
    {
      ...metadata,
      files: metadata.files.concat({ ...metadata.files[0]!, path: "/Lib/os.py/child" }),
    },
  ],
];
for (const [name, value] of invalidManifests) {
  test(`invalid manifest ${name} fails before any filesystem operation`, async (context) => {
    const state = fixture(context);
    state.manifest(value);
    await assert.rejects(
      state.payload.load(async () => wasm),
      TypeError,
    );
    assert.equal(state.calls.length, 0);
  });
}

for (const mismatch of ["byte count", "hash"]) {
  test(`${mismatch} mismatch fails before writes and a later attempt retries`, async (context) => {
    const state = fixture(context);
    state.manifest({
      ...metadata,
      files: metadata.files.map((file) => ({
        ...file,
        ...(mismatch === "hash" ? { sha256: "0".repeat(64) } : { bytes: file.bytes + 1 }),
      })),
    });
    await assert.rejects(
      state.payload.load(async () => wasm),
      (error) => message(error).includes(`${mismatch} mismatch`),
    );
    assert.equal(state.calls.length, 0);
    state.manifest(metadata);
    await state.payload.load(async () => wasm);
    assert.equal(state.files.size, data.size);
  });
}

for (const failed of ["manifest", "file"]) {
  test(`${failed} fetch failure is retryable and joined`, async (context) => {
    const state = fixture(context);
    state.fetch(async (url) => {
      if (url.includes(failed === "manifest" ? "manifest.json" : "os.py"))
        throw new Error("offline");
    });
    await assert.rejects(
      state.payload.load(async () => wasm),
      (error) => message(error).includes("offline"),
    );
    assert.equal(state.calls.length, 0);
    state.fetch(async () => {});
    await state.payload.load(async () => wasm);
    assert.equal(state.files.size, data.size);
  });
}

test("exclusive-create race preserves the winner and rolls back earlier created files", async (context) => {
  const state = fixture(context);
  let writes = 0;
  let winner = "";
  state.write(async (path) => {
    if (++writes !== 2) return;
    winner = path;
    state.files.set(path, encode("concurrent owner"));
  });
  await assert.rejects(
    state.payload.load(async () => wasm),
    /EEXIST/,
  );
  assert.deepEqual(Array.from(state.files), [[winner, encode("concurrent owner")]]);
  assert.equal(state.removed.length, 1);
});

test("drain failure rolls back only unchanged attempt files and retries", async (context) => {
  const state = fixture(context);
  state.files.set("/Lib/os.py", data.get("/Lib/os.py")!);
  let drains = 0;
  state.drain(async () => {
    if (++drains === 1) throw new Error("disk failure");
  });
  await assert.rejects(
    state.payload.load(async () => wasm),
    /disk failure/,
  );
  assert.deepEqual(Array.from(state.files.keys()), ["/Lib/os.py"]);
  await state.payload.load(async () => wasm);
  assert.equal(state.files.size, data.size);
});

test("interpreter failure joins payload loading and rolls back its files", async (context) => {
  const state = fixture(context);
  await assert.rejects(
    state.payload.load(async () => {
      throw new Error("interpreter unavailable");
    }),
    /interpreter unavailable/,
  );
  assert.equal(state.files.size, 0);
  assert.equal(state.fetched.length, metadata.files.length + 1);
  await state.payload.load(async () => wasm);
});

test("original preparation failure and cleanup failure are both reported", async (context) => {
  const state = fixture(context);
  let drains = 0;
  state.drain(async () => {
    throw new Error(++drains === 1 ? "prepare failure" : "cleanup failure");
  });
  await assert.rejects(
    state.payload.load(async () => wasm),
    (error) =>
      message(error).includes("prepare failure") && message(error).includes("cleanup failure"),
  );
  state.drain(async () => {});
});

test("disposal during fetch joins both sources and prevents all later writes", async (context) => {
  const state = fixture(context);
  const entered = deferred();
  const resume = deferred();
  const interpreter = deferred();
  state.fetch(async () => {
    entered.resolve();
    await resume.promise;
  });
  const loading = state.payload.load(async () => {
    await interpreter.promise;
    return wasm;
  });
  const rejected = assert.rejects(loading, (error) => message(error).includes("disposed"));
  await entered.promise;
  const disposal = state.payload.dispose();
  let disposed = false;
  void disposal.then(() => {
    disposed = true;
  });
  resume.resolve();
  await Promise.resolve();
  assert.equal(disposed, false);
  interpreter.resolve();
  await Promise.all([disposal, rejected]);
  assert.equal(state.calls.length, 0);
});

async function pausedPreparation(context: TestContext, phase: "write" | "drain") {
  const state = fixture(context);
  const entered = deferred();
  const resume = deferred();
  state[phase](async () => {
    entered.resolve();
    await resume.promise;
  });
  const rejected = assert.rejects(
    state.payload.load(async () => wasm),
    /disposed/,
  );
  await entered.promise;
  return { state, resume: resume.resolve, rejected };
}

test("disposal joins an admitted write and removes it before resolving", async (context) => {
  const { state, resume, rejected } = await pausedPreparation(context, "write");
  const disposal = state.payload.dispose();
  resume();
  await Promise.all([disposal, rejected]);
  assert.equal(state.files.size, 0);
  assert.equal(state.calls.filter((call) => call.startsWith("write:")).length, 1);
});

test("runtime disposal stops pending preparation and prevents cleanup filesystem calls", async (context) => {
  const { state, resume, rejected } = await pausedPreparation(context, "drain");
  state.runtime.disposed = true;
  const count = state.calls.length;
  resume();
  await rejected;
  await state.payload.dispose();
  assert.equal(state.calls.length, count);
});

test("disposal before first use is quiet and prevents a later source load", async (context) => {
  const state = fixture(context);
  await state.payload.dispose();
  await assert.rejects(
    state.payload.load(async () => wasm),
    /disposed/,
  );
  assert.equal(state.calls.length + state.fetched.length, 0);
});

test("rollback preserves a file edited after population and unrelated caller files", async (context) => {
  const state = fixture(context);
  let drains = 0;
  state.drain(async () => {
    if (++drains !== 1) return;
    state.files.set("/Lib/os.py", encode("caller edit"));
    state.files.set("/Lib/caller.py", encode("caller file"));
    throw new Error("drain failed");
  });
  await assert.rejects(
    state.payload.load(async () => wasm),
    /drain failed/,
  );
  assert.deepEqual(Array.from(state.files), [
    ["/Lib/os.py", encode("caller edit")],
    ["/Lib/caller.py", encode("caller file")],
  ]);
  assert.equal(state.removed.includes("/Lib/os.py"), false);
});

for (const kind of ["dir", "symlink"]) {
  test(`disposal preserves an owned file replaced with a ${kind}`, async (context) => {
    const state = fixture(context);
    await state.payload.load(async () => wasm);
    state.files.delete("/Lib/os.py");
    const replacement: Entry =
      kind === "dir"
        ? { kind: "dir", ino: 3, mtime: 0, children: new Map() }
        : { kind: "symlink", ino: 3, mtime: 0, target: "/foreign" };
    state.entries.set("/Lib/os.py", replacement);
    await state.payload.dispose();
    assert.equal(state.entries.get("/Lib/os.py"), replacement);
    assert.equal(state.removed.includes("/Lib/os.py"), false);
  });
}
