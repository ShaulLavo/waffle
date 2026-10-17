import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { Shell } from "../src/shell";

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const transpiler = new Bun.Transpiler({ loader: "ts" });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// This tree represents the durable image after every successful mutation: background
// persistence may publish any prefix of startup, before its explicit final checkpoint.
function seedTreeFixture() {
  const files = new Map<string, string>();
  const directories = new Set<string>();
  const fs = {
    beforeWrite: undefined as ((path: string) => void) | undefined,
    checkpoints: 0,
    async mkdirp(path: string) {
      const parts = path.split("/").filter(Boolean);
      for (let length = 1; length <= parts.length; length++) directories.add(`/${parts.slice(0, length).join("/")}`);
    },
    async lookup(path: string) { return directories.has(path) ? { kind: "dir" } : files.has(path) ? { kind: "file" } : undefined; },
    async writeFile(path: string, text: string) {
      await fs.mkdirp(path.slice(0, path.lastIndexOf("/")));
      fs.beforeWrite?.(path);
      files.set(path, text);
    },
    async remove(path: string) {
      for (const key of files.keys()) if (key === path || key.startsWith(`${path}/`)) files.delete(key);
      for (const key of directories) if (key === path || key.startsWith(`${path}/`)) directories.delete(key);
    },
    async flush() { fs.checkpoints++; },
  };
  return { fs, files, directories };
}

class View {
  state: EditorState;
  constructor(options: { state?: EditorState }) { this.state = options.state ?? EditorState.create(); }
  setState(state: EditorState) { this.state = state; }
}

// Exercise the actual UI classes without booting their wasm engines, terminal, or DOM.
// Only rendering/extensions are replaced; open/save/sync/scheduling execute unchanged.
async function editorFixture(app: "web" | "sandbox") {
  const source = await Bun.file(new URL(app === "web" ? "../src/main.ts" : "../../sandbox/src/main.ts", import.meta.url)).text();
  const end = app === "web" ? "const editor = new Editor" : "// ---------- file tree ----------";
  const code = source.slice(source.indexOf("class Editor {"), source.indexOf(end));
  const reads = new Map<string, ReturnType<typeof deferred<Uint8Array | undefined>>>();
  const writes: { path: string; text: string; done: ReturnType<typeof deferred<void>> }[] = [];
  const statuses: string[] = [];
  const checkpoints: ReturnType<typeof deferred<void>>[] = [];
  const fs = {
    readFile(path: string) { return reads.get(path)?.promise ?? Promise.resolve(encoder.encode(path)); },
    writeFile(path: string, text: string) {
      const done = deferred<void>();
      writes.push({ path, text, done });
      return done.promise;
    },
    listFiles: async () => [],
    flush: () => checkpoints.shift()?.promise ?? Promise.resolve(),
  };
  const saveCode = app === "sandbox"
    ? source.slice(source.indexOf("async function save("), source.indexOf("function reportError("))
    : "";
  const env = {
    fs, EditorState, EditorView: View, HOME: "/home/user", decode: (bytes: Uint8Array) => decoder.decode(bytes),
    abs: (path: string) => `/home/user/app/${path}`, fileName: {}, fileSelect: {}, tree: { select() {} },
    setSaveState: (text: string) => statuses.push(text), SAVE_DELAY_MS: 350,
    server: null, run: null, unsent: new Map(), sendUpdate() {},
  };
  const Editor = new Function(...Object.keys(env), `${transpiler.transformSync(`let editRevision = 0; ${saveCode} ${code}`)}; return Editor;`)(...Object.values(env));
  Editor.prototype.extensions = () => [];
  Editor.prototype.renderTabs = async () => {};
  const editor = new Editor({});
  return { editor, reads, writes, statuses, checkpoints };
}

for (const app of ["web", "sandbox"] as const) {
  describe(`${app} async editor`, () => {
    const path = (name: string) => app === "web" ? `/home/user/${name}` : name;
    const absolute = (name: string) => app === "web" ? `/home/user/${name}` : `/home/user/app/${name}`;

    test("the latest open wins without saving the previous view under a pending path", async () => {
      const { editor, reads } = await editorFixture(app);
      await editor.open(path("initial.ts"));
      editor.view.state = EditorState.create({ doc: "unsaved initial" });
      const older = deferred<Uint8Array | undefined>();
      const newer = deferred<Uint8Array | undefined>();
      reads.set(absolute("older.ts"), older);
      reads.set(absolute("newer.ts"), newer);
      const a = editor.open(path("older.ts"));
      const b = editor.open(path("newer.ts"));
      expect(editor.path).toBe(path("initial.ts"));
      newer.resolve(encoder.encode("newer"));
      await b;
      older.resolve(encoder.encode("older"));
      await a;
      expect(editor.path).toBe(path("newer.ts"));
      expect(editor.view.state.doc.toString()).toBe("newer");
      await editor.open(path("initial.ts"));
      expect(editor.view.state.doc.toString()).toBe("unsaved initial");
    });

    test("selecting the current file cancels an outstanding open", async () => {
      const { editor, reads } = await editorFixture(app);
      await editor.open(path("initial.ts"));
      const pending = deferred<Uint8Array | undefined>();
      reads.set(absolute("pending.ts"), pending);
      const opening = editor.open(path("pending.ts"));
      await editor.open(path("initial.ts"));
      pending.resolve(encoder.encode("pending"));
      await opening;
      expect(editor.path).toBe(path("initial.ts"));
    });
  });
}

test("playground save completion belongs to its original file, not the newly selected tab", async () => {
  const { editor, writes } = await editorFixture("web");
  await editor.open("/home/user/a.ts");
  editor.view.state = EditorState.create({ doc: "edited A" });
  const saving = editor.save();
  await editor.open("/home/user/b.ts");
  writes[0]!.done.resolve();
  await saving;
  expect(writes[0]!.path).toBe("/home/user/a.ts");
  expect(editor.saved.get("/home/user/a.ts")).toBe("edited A");
  expect(editor.saved.get("/home/user/b.ts")).toBe("/home/user/b.ts");
});

for (const app of ["web", "sandbox"] as const) {
  test(`${app} save stays dirty until its durable checkpoint resolves`, async () => {
    const { editor, writes, statuses, checkpoints } = await editorFixture(app);
    const path = app === "web" ? "/home/user/a.ts" : "src/main.ts";
    await editor.open(path);
    editor.view.state = EditorState.create({ doc: "durable edit" });
    const checkpoint = deferred<void>();
    checkpoints.push(checkpoint);
    let completed = false;
    const saving = (app === "web" ? editor.save() : editor.flush(path)).then(() => { completed = true; });
    writes[0]!.done.resolve();
    // Let every continuation of the memory write run while storage is still pending.
    await Bun.sleep(0);
    expect(completed).toBe(false);
    if (app === "web") expect(editor.dirty(path)).toBe(true);
    else expect(statuses).not.toContain("saved");
    checkpoint.resolve();
    await saving;
    if (app === "web") expect(editor.saved.get(path)).toBe("durable edit");
    else expect(statuses.at(-1)).toBe("saved");
  });

  test(`${app} failed durability checkpoint never marks the edit saved`, async () => {
    const { editor, writes, statuses, checkpoints } = await editorFixture(app);
    const path = app === "web" ? "/home/user/a.ts" : "src/main.ts";
    await editor.open(path);
    editor.view.state = EditorState.create({ doc: "must remain dirty" });
    const checkpoint = deferred<void>();
    checkpoints.push(checkpoint);
    // Keep the deliberately rejected backend promise observed even against the old save path.
    void checkpoint.promise.catch(() => {});
    const saving: Promise<unknown> = (app === "web" ? editor.save() : editor.flush(path)).catch((error: unknown) => error);
    writes[0]!.done.resolve();
    await Bun.sleep(0);
    checkpoint.reject(new Error("storage full"));
    expect(await saving).toEqual(new Error("storage full"));
    if (app === "web") expect(editor.dirty(path)).toBe(true);
    else expect(statuses.at(-1)).toBe("not saved: Error: storage full");
    expect(statuses).not.toContain("saved");
  });
}

test("playground sync preserves edits made while a filesystem read is pending", async () => {
  const { editor, reads } = await editorFixture("web");
  await editor.open("/home/user/a.ts");
  const reading = deferred<Uint8Array | undefined>();
  reads.set("/home/user/a.ts", reading);
  const syncing = editor.syncFromFs();
  editor.view.state = EditorState.create({ doc: "typed during read" });
  reading.resolve(encoder.encode("external change"));
  await syncing;
  expect(editor.view.state.doc.toString()).toBe("typed during read");
});

test("sandbox reset cancels debounced writes and locks the editor before replacing files", async () => {
  const { editor, writes } = await editorFixture("sandbox");
  await editor.open("src/main.ts");
  editor.schedule("src/main.ts");
  expect(editor.timers.size).toBe(1);
  editor.discard();
  expect(editor.timers.size).toBe(0);
  expect(editor.view.state.readOnly).toBe(true);
  expect(writes).toEqual([]);
});

test("sandbox reset waits for the stopped guest and durable template before reloading", async () => {
  const source = await Bun.file(new URL("../../sandbox/src/main.ts", import.meta.url)).text();
  const code = source.slice(source.indexOf("async function resetTemplate("), source.indexOf("resetButton.addEventListener("));
  const stopped = deferred<void>();
  const checkpoint = deferred<void>();
  const events: string[] = [];
  const env = {
    editor: { discard() { events.push("discard"); } }, run: { done: stopped.promise },
    stopDevServer() { events.push("stop"); },
    loadTemplate(reset: boolean) { events.push(`template:${reset}`); return checkpoint.promise; },
    location: { reload() { events.push("reload"); } },
  };
  const reset = new Function(...Object.keys(env), `${transpiler.transformSync(code)}; return resetTemplate;`)(...Object.values(env));
  const resetting = reset();
  expect(events).toEqual(["discard", "stop"]);
  stopped.resolve();
  await Bun.sleep(0);
  expect(events).toEqual(["discard", "stop", "template:true"]);
  checkpoint.resolve();
  await resetting;
  expect(events).toEqual(["discard", "stop", "template:true", "reload"]);
});

test("sandbox reports failed filesystem saves and rejects explicit flush", async () => {
  const { editor, writes, statuses } = await editorFixture("sandbox");
  await editor.open("src/main.ts");
  const saving = editor.flush("src/main.ts");
  writes[0]!.done.reject(new Error("filesystem unavailable"));
  await expect(saving).rejects.toThrow("filesystem unavailable");
  expect(statuses.at(-1)).toBe("not saved: Error: filesystem unavailable");
});

test("sandbox HMR notifications stay ordered and stale replies do not replace the latest status", async () => {
  const source = await Bun.file(new URL("../../sandbox/src/main.ts", import.meta.url)).text();
  const code = source.slice(source.indexOf("async function sendUpdate("), source.indexOf("async function save("));
  const first = deferred<void>();
  const sent: string[][] = [];
  const statuses: string[] = [];
  const server = {
    updates: Promise.resolve(),
    helper: { notifyFileChanged(...args: string[]) { sent.push(args); return sent.length === 1 ? first.promise : Promise.resolve(); } },
  };
  const sendUpdate = new Function("server", "abs", "setSaveState", `${transpiler.transformSync(`let editRevision = 2; ${code}`)}; return sendUpdate;`)(server, (path: string) => path, (text: string) => statuses.push(text));
  const older = sendUpdate("file.ts", 1);
  const newer = sendUpdate("file.ts", 2);
  await Promise.resolve();
  expect(sent).toEqual([["file.ts"]]);
  expect(statuses).toEqual([]);
  first.resolve();
  await Promise.all([older, newer]);
  expect(sent).toEqual([["file.ts"], ["file.ts"]]);
  expect(statuses).toEqual(["saved"]);
});

test("playground storage selection defaults to IndexedDB and requires an explicit OPFS query", async () => {
  const source = await Bun.file(new URL("../src/main.ts", import.meta.url)).text();
  const selector = source.match(/^const storage = .*;$/m)![0];
  const select = new Function("params", `${transpiler.transformSync(selector)} return storage;`);
  expect(select(new URLSearchParams())).toBe("indexeddb");
  expect(select(new URLSearchParams("storage=opfs"))).toBe("opfs");
  expect(select(new URLSearchParams("storage=unknown"))).toBe("indexeddb");
});

test("playground only seeds examples in a new home, preserving changes and deletions on reload", async () => {
  const source = await Bun.file(new URL("../src/main.ts", import.meta.url)).text();
  const code = source.slice(source.indexOf("const runtime = createRuntime"), source.indexOf("// ---------- bun.wasm ----------"));
  const files = new Map<string, string>();
  const directories = new Set<string>();
  let checkpoints = 0;
  const fs = {
    async mkdirp(path: string) { directories.add(path); },
    async lookup(path: string) { return directories.has(path) ? { kind: "dir" } : undefined; },
    async writeFile(path: string, text: string) { files.set(path, text); },
    async remove(path: string) {
      for (const key of files.keys()) if (key.startsWith(`${path}/`)) files.delete(key);
      for (const key of directories) if (key === path || key.startsWith(`${path}/`)) directories.delete(key);
    },
    async flush() { checkpoints++; },
  };
  const startup = new Function("createRuntime", "HOME", "examples", "storage", `return (async () => { ${transpiler.transformSync(code)} })();`);
  const start = () => startup(() => ({ filesystem: fs }), "/home/user", { "index.ts": "example", "deleted.ts": "delete me" }, "indexeddb");
  await start();
  expect(files.get("/home/user/index.ts")).toBe("example");
  expect(checkpoints).toBe(1);
  files.set("/home/user/index.ts", "saved edit");
  files.delete("/home/user/deleted.ts");
  await start();
  expect(files.get("/home/user/index.ts")).toBe("saved edit");
  expect(files.has("/home/user/deleted.ts")).toBe(false);
  expect(checkpoints).toBe(1);
});

test("sandbox reload preserves its workspace and only an explicit reset replaces the template", async () => {
  const source = await Bun.file(new URL("../../sandbox/src/main.ts", import.meta.url)).text();
  const code = source.slice(source.indexOf("function templateFiles("), source.indexOf("// ---------- terminal ----------"));
  const files = new Map<string, string>();
  const directories = new Set<string>();
  const template = { "index.html": "original page", "src/main.ts": "original code", "removed.ts": "remove me", "package.json": "{}", "node_modules/react/index.js": "dependency" };
  let checkpoints = 0;
  const fs = {
    async mkdirp(path: string) { directories.add(path); },
    async lookup(path: string) { return directories.has(path) ? { kind: "dir" } : undefined; },
    async writeFile(path: string, text: string) { files.set(path, text); directories.add("/home/user/app"); },
    async remove(path: string) {
      for (const key of files.keys()) if (key.startsWith(`${path}/`)) files.delete(key);
      for (const key of directories) if (key === path || key.startsWith(`${path}/`)) directories.delete(key);
    },
    async flush() { checkpoints++; },
    async listFiles() { return Array.from(files.keys()); },
    async readFile(path: string) { const text = files.get(path); return text === undefined ? undefined : encoder.encode(text); },
  };
  const env = {
    fs, APP: "/home/user/app", abs: (path: string) => `/home/user/app/${path}`,
    rel: (path: string) => path.slice("/home/user/app/".length), decode: (bytes: Uint8Array) => decoder.decode(bytes),
    templateFile: "template.json", measureStartup() {},
    fetch: async () => ({ ok: true, text: async () => JSON.stringify({ files: template }) }),
  };
  const { load, changed } = new Function(...Object.keys(env), `${transpiler.transformSync(code)}; return { load: loadTemplate, changed: dependenciesChanged };`)(...Object.values(env));
  await load();
  expect(await changed()).toBe(false);
  expect(files.get("/home/user/app/src/main.ts")).toBe("original code");
  expect(checkpoints).toBe(1);
  files.set("/home/user/app/src/main.ts", "saved edit");
  files.delete("/home/user/app/removed.ts");
  files.set("/home/user/app/custom.ts", "new file");
  files.set("/home/user/app/package.json", "{\"edited\":true}");
  await load();
  expect(await changed()).toBe(true);
  expect(files.get("/home/user/app/src/main.ts")).toBe("saved edit");
  expect(files.has("/home/user/app/removed.ts")).toBe(false);
  expect(files.get("/home/user/app/custom.ts")).toBe("new file");
  expect(checkpoints).toBe(1);
  await load(true);
  expect(files.get("/home/user/app/src/main.ts")).toBe("original code");
  expect(files.has("/home/user/app/removed.ts")).toBe(true);
  expect(files.has("/home/user/app/custom.ts")).toBe(false);
  expect(checkpoints).toBe(2);
  expect(await changed()).toBe(false);
  files.set("/home/user/app/node_modules/added/index.js", "added dependency");
  expect(await changed()).toBe(true);
  files.delete("/home/user/app/node_modules/added/index.js");
  files.delete("/home/user/app/node_modules/react/index.js");
  expect(await changed()).toBe(true);
});

for (const app of ["web", "sandbox"] as const) {
  test(`${app} reload retries a seed interrupted after its directory and first file persisted`, async () => {
    const source = await Bun.file(new URL(app === "web" ? "../src/main.ts" : "../../sandbox/src/main.ts", import.meta.url)).text();
    const code = app === "web"
      ? source.slice(source.indexOf("const runtime = createRuntime"), source.indexOf("// ---------- bun.wasm ----------"))
      : source.slice(source.indexOf("function templateFiles("), source.indexOf("// ---------- terminal ----------"));
    const { fs, files } = seedTreeFixture();
    const workspace = app === "web" ? "/home/user" : "/home/user/app";
    const sources = { "index.html": "page", "first.ts": "first file", "second.ts": "second file" };
    const env = {
      createRuntime: () => ({ filesystem: fs }), fs, HOME: workspace, APP: workspace, examples: sources, storage: "indexeddb",
      setStatus() {}, templateFile: "template.json", measureStartup() {},
      abs: (path: string) => `${workspace}/${path}`,
      fetch: async () => ({ ok: true, text: async () => JSON.stringify({ files: sources }) }),
    };
    const startup = new Function(...Object.keys(env), `return async () => { ${transpiler.transformSync(code)} ${app === "sandbox" ? "await loadTemplate();" : ""} };`)(...Object.values(env));
    fs.beforeWrite = path => { if (path.endsWith("/second.ts")) throw new Error("interrupted seed"); };
    await expect(startup()).rejects.toThrow("interrupted seed");
    expect(await fs.lookup(workspace)).toBeDefined();
    expect(files.get(`${workspace}/first.ts`)).toBe("first file");
    expect(files.has(`${workspace}/second.ts`)).toBe(false);
    fs.beforeWrite = undefined;
    await startup();
    expect(files.get(`${workspace}/second.ts`)).toBe("second file");
    expect(fs.checkpoints).toBe(1);
    files.delete(`${workspace}/first.ts`);
    await startup();
    expect(files.has(`${workspace}/first.ts`)).toBe(false);
  });
}

test("sandbox reload completes a reset interrupted after persisting only part of its template", async () => {
  const source = await Bun.file(new URL("../../sandbox/src/main.ts", import.meta.url)).text();
  const code = source.slice(source.indexOf("function templateFiles("), source.indexOf("// ---------- terminal ----------"));
  const { fs, files } = seedTreeFixture();
  const sources = { "index.html": "template page", "first.ts": "template first", "second.ts": "template second" };
  const env = {
    fs, APP: "/home/user/app", abs: (path: string) => `/home/user/app/${path}`,
    templateFile: "template.json", measureStartup() {},
    fetch: async () => ({ ok: true, text: async () => JSON.stringify({ files: sources }) }),
  };
  const load = new Function(...Object.keys(env), `${transpiler.transformSync(code)}; return loadTemplate;`)(...Object.values(env));
  await load();
  files.set("/home/user/app/first.ts", "user edit");
  files.set("/home/user/app/custom.ts", "custom file");
  fs.beforeWrite = path => { if (path.endsWith("/second.ts")) throw new Error("interrupted reset"); };
  await expect(load(true)).rejects.toThrow("interrupted reset");
  expect(files.get("/home/user/app/first.ts")).toBe("template first");
  expect(files.has("/home/user/app/second.ts")).toBe(false);
  fs.beforeWrite = undefined;
  await load();
  expect(files.get("/home/user/app/second.ts")).toBe("template second");
  expect(files.has("/home/user/app/custom.ts")).toBe(false);
  files.delete("/home/user/app/first.ts");
  await load();
  expect(files.has("/home/user/app/first.ts")).toBe(false);
});

test("sandbox only wakes HMR after the durable save and never on checkpoint failure", async () => {
  const source = await Bun.file(new URL("../../sandbox/src/main.ts", import.meta.url)).text();
  const code = source.slice(source.indexOf("async function save("), source.indexOf("function reportError("));
  const checkpoint = deferred<void>();
  const failure = new Error("durability unavailable");
  const notifications: string[] = [];
  const fs = { writeFile: async () => {}, flush: () => checkpoint.promise };
  const env = { fs, server: {}, abs: (path: string) => path, sendUpdate: async (path: string) => { notifications.push(path); }, rememberEdit() {} };
  const save = new Function(...Object.keys(env), `${transpiler.transformSync(code)}; return save;`)(...Object.values(env));
  const saving = save("file.ts", "new text", 1);
  await Bun.sleep(0);
  expect(notifications).toEqual([]);
  checkpoint.resolve();
  await saving;
  expect(notifications).toEqual(["file.ts"]);
  fs.flush = async () => { throw failure; };
  await expect(save("file.ts", "not durable", 2)).rejects.toBe(failure);
  expect(notifications).toEqual(["file.ts"]);
});

test("shell discards filesystem completion after the line was submitted", async () => {
  const lookup = deferred<undefined>();
  const shell = new Shell({ cols: 100, onData() {}, write() {}, writeln() {} } as never, {
    fs: { lookup: () => lookup.promise } as never,
    runBun: async () => 0, kill() {}, changed() {}, open() {}, info: () => [],
  });
  const ui = shell as unknown as { line: string; cursor: number; busy: boolean; complete(): Promise<void> };
  ui.line = "cat f";
  ui.cursor = ui.line.length;
  const completing = ui.complete();
  ui.busy = true;
  lookup.resolve({ kind: "dir", children: new Map([["file.ts", { kind: "file" }]]) } as never);
  await completing;
  expect(ui.line).toBe("cat f");
});

async function filesystemFixture() {
  const source = await Bun.file(new URL(import.meta.resolve("@bun-wasm/runtime/browser/shared-fs"))).text();
  const code = source.slice(source.indexOf("export class SharedFilesystem")).replace("export class", "class");
  const Filesystem = new Function(`${transpiler.transformSync(code)}; return SharedFilesystem;`)();
  const fs = Object.create(Filesystem.prototype);
  fs.writes = Promise.resolve();
  return fs;
}

test("shared filesystem reads drain writes without requesting storage checkpoints", async () => {
  const fs = await filesystemFixture();
  const write = deferred<void>();
  const operations: string[] = [];
  fs.client = { asyncCall: (operation: string) => { operations.push(operation); return operation === "writeFile" ? write.promise : Promise.resolve(); } };
  const writing = fs.writeFile("/file", "memory-first");
  const reading = fs.readFile("/file");
  const lookup = fs.lookup("/file");
  const listing = fs.listFiles();
  await Bun.sleep(0);
  expect(operations).toEqual(["writeFile"]);
  write.resolve();
  await Promise.all([writing, reading, lookup, listing]);
  expect(operations).toEqual(["writeFile", "readFile", "lookup", "listFiles"]);
});

test("shared filesystem flush waits for pending writes and a durable service checkpoint", async () => {
  const fs = await filesystemFixture();
  const write = deferred<void>();
  const checkpoint = deferred<void>();
  const operations: string[] = [];
  fs.client = { asyncCall: (operation: string) => { operations.push(operation); return operation === "writeFile" ? write.promise : checkpoint.promise; } };
  const writing = fs.writeFile("/file", "durable");
  let completed = false;
  const saving = fs.flush().then(() => { completed = true; });
  await Bun.sleep(0);
  expect(operations).toEqual(["writeFile"]);
  write.resolve();
  await writing;
  await Bun.sleep(0);
  expect(operations).toEqual(["writeFile", "flush"]);
  expect(completed).toBe(false);
  checkpoint.resolve();
  await saving;
});

test("shared filesystem flush reports failed writes and permits later writes", async () => {
  const fs = await filesystemFixture();
  const failure = new Error("failed editor save");
  fs.client = { asyncCall: async () => { throw failure; } };
  await expect(fs.writeFile("/file", "first")).rejects.toBe(failure);
  await expect(fs.flush()).rejects.toBe(failure);
  fs.client = { asyncCall: async () => {} };
  await fs.writeFile("/file", "second");
  await fs.flush();
});

test("sandbox Restart is available while the initial dev server is still running", async () => {
  const source = await Bun.file(new URL("../../sandbox/src/main.ts", import.meta.url)).text();
  const state = source.match(/^let startup:.*$/m)![0];
  const listener = source.slice(source.indexOf('restartButton.addEventListener("click"'), source.indexOf("async function resetTemplate("));
  const boot = source.slice(source.indexOf("async function boot("), source.indexOf("Object.assign(globalThis, { sandbox:"));
  const initialization = deferred<void>(), launched = deferred<void>(), guest = deferred<void>();
  let click = () => {}, starts = 0;
  const failures: unknown[] = [];
  const env = {
    fs: { mkdirp: () => initialization.promise, lookup: async () => ({ kind: "file" }), listFiles: async () => [] },
    restartButton: { addEventListener(_event: string, listener: () => void) { click = listener; } },
    location: { reload() { throw new Error("A running server should restart without reloading the workspace"); } },
    term: { write() {} }, setServerState() {}, setStatus() {},
    loadTemplate: async () => {}, loadWasm: async () => ({}),
    tree: { render: async () => {} }, editor: { open: async () => {} },
    abs: (path: string) => path, rel: (path: string) => path, START_FILE: "src/App.tsx",
    wasmUrl: "fixture.wasm", engine: "browser", ENGINES: { browser: { name: "browser" } }, WasmMissing: Error,
    startDevServer() { starts++; launched.resolve(); return guest.promise; },
    showStartupFailure: (error: unknown) => failures.push(error), reportError: (error: unknown) => failures.push(error),
  };
  new Function(...Object.keys(env), transpiler.transformSync(`${state}\nlet wasm = null;\n${listener}\n${boot}`))(...Object.values(env));
  try {
    click();
    expect(starts).toBe(0);
    initialization.resolve();
    await launched.promise;
    click();
    expect(starts).toBe(2);
    expect(failures).toEqual([]);
  } finally { initialization.resolve(); guest.resolve(); }
});
