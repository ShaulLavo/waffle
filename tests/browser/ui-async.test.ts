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
  const fs = {
    readFile(path: string) { return reads.get(path)?.promise ?? Promise.resolve(encoder.encode(path)); },
    writeFile(path: string, text: string) {
      const done = deferred<void>();
      writes.push({ path, text, done });
      return done.promise;
    },
    listFiles: async () => [],
    flush: async () => {},
  };
  const env = {
    fs, EditorState, EditorView: View, HOME: "/home/user", decode: (bytes: Uint8Array) => decoder.decode(bytes),
    abs: (path: string) => `/home/user/app/${path}`, fileName: {}, fileSelect: {}, tree: { select() {} },
    setSaveState: (text: string) => statuses.push(text), rememberEdit() {}, SAVE_DELAY_MS: 350,
    save: (path: string, text: string) => fs.writeFile(`/home/user/app/${path}`, text),
  };
  const Editor = new Function(...Object.keys(env), `${transpiler.transformSync(`let editRevision = 0; ${code}`)}; return Editor;`)(...Object.values(env));
  Editor.prototype.extensions = () => [];
  Editor.prototype.renderTabs = async () => {};
  const editor = new Editor({});
  return { editor, reads, writes, statuses };
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

test("shared filesystem flush reports failed writes and permits later writes", async () => {
  const source = await Bun.file(new URL("../src/shared-fs.ts", import.meta.url)).text();
  const code = source.slice(source.indexOf("export class SharedFilesystem")).replace("export class", "class");
  const Filesystem = new Function(`${transpiler.transformSync(code)}; return SharedFilesystem;`)();
  const fs = Object.create(Filesystem.prototype);
  fs.writes = Promise.resolve();
  const failure = new Error("failed editor save");
  fs.client = { asyncCall: async () => { throw failure; } };
  await expect(fs.writeFile("/file", "first")).rejects.toBe(failure);
  await expect(fs.flush()).rejects.toBe(failure);
  fs.client = { asyncCall: async () => {} };
  await fs.writeFile("/file", "second");
  await fs.flush();
});
