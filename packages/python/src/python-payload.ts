export const PYTHON_ARGV0 = "/cross-build/wasm32-wasip1/python.wasm";
const CPYTHON = "5e58eaad7c58df58dfa8ea549c87996e01dd1077";
const BUILD = "/cross-build/wasm32-wasip1/";
const MARKER = `${BUILD}pybuilddir.txt`;
const GENERATED = `${BUILD}build/lib.wasi-wasm32-3.15/`;

export interface PythonPayloadFile {
  readonly path: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface PythonPayloadManifest {
  readonly format: 1;
  readonly cpython: "5e58eaad7c58df58dfa8ea549c87996e01dd1077";
  readonly argv0: "/cross-build/wasm32-wasip1/python.wasm";
  readonly files: readonly PythonPayloadFile[];
}

export type PythonPayloadSource =
  | PythonPayloadManifest
  | (() => PythonPayloadManifest | Promise<PythonPayloadManifest>);

export type PythonPayloadOptions =
  | { readonly payloadUrl?: string | URL; readonly payload?: never }
  | { readonly payload: PythonPayloadSource; readonly payloadUrl?: never };

export interface PythonPayloadFilesystem {
  lookup(path: string): Promise<{ readonly kind: string } | undefined>;
  readFile(path: string): Promise<Uint8Array | undefined>;
  mkdirp(path: string): Promise<void>;
  writeFile(path: string, bytes: string | Uint8Array, mode: { readonly exclusive: true }): Promise<void>;
  remove(path: string): Promise<unknown>;
  drain(): Promise<void>;
}

export interface PythonPayloadRuntime {
  readonly disposed: boolean;
  readonly filesystem: PythonPayloadFilesystem;
}

type PayloadFile = { readonly path: string; readonly bytes: Uint8Array<ArrayBuffer> };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseFile(value: unknown): PythonPayloadFile {
  if (!record(value)) throw new TypeError("Invalid Python payload file");
  if (Object.keys(value).some((key) => !["path", "url", "bytes", "sha256"].includes(key)))
    throw new TypeError("Python payload entries must describe regular files only");
  const { path, url, bytes, sha256 } = value;
  if (typeof path !== "string" || !path.startsWith("/") || /[\\\0]/.test(path))
    throw new TypeError("Invalid Python payload path");
  if (
    path
      .slice(1)
      .split("/")
      .some((part) => !part || part === "." || part === "..")
  )
    throw new TypeError(`Noncanonical Python payload path: ${path}`);
  if (!(path.startsWith("/Lib/") || path === MARKER || path.startsWith(GENERATED)))
    throw new TypeError(`Unexpected Python payload path: ${path}`);
  if (
    typeof url !== "string" ||
    !url ||
    typeof bytes !== "number" ||
    !Number.isSafeInteger(bytes) ||
    bytes < 0
  )
    throw new TypeError(`Invalid Python payload URL or byte count: ${path}`);
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256))
    throw new TypeError(`Invalid Python payload SHA-256: ${path}`);
  return { path, url, bytes, sha256 };
}

export function parsePythonPayloadManifest(value: unknown): PythonPayloadManifest {
  if (
    !record(value) ||
    value.format !== 1 ||
    value.cpython !== CPYTHON ||
    value.argv0 !== PYTHON_ARGV0 ||
    !Array.isArray(value.files)
  )
    throw new TypeError("Invalid Python payload manifest identity");
  const input: unknown[] = value.files;
  const files = input.map(parseFile);
  const paths = new Set<string>();
  for (const file of files) {
    if (paths.has(file.path)) throw new TypeError(`Duplicate Python payload path: ${file.path}`);
    paths.add(file.path);
  }
  for (const path of paths) {
    if (parents(path).some((parent) => paths.has(parent)))
      throw new TypeError(`Python payload file is also a directory: ${path}`);
  }
  if (!paths.has("/Lib/os.py") || !paths.has(MARKER))
    throw new TypeError("Python payload is missing os.py or pybuilddir.txt");
  return { format: 1, cpython: CPYTHON, argv0: PYTHON_ARGV0, files };
}

function parents(path: string): string[] {
  const parts = path.slice(1).split("/");
  return parts.slice(0, -1).map((_, index) => "/" + parts.slice(0, index + 1).join("/"));
}

function sameBytes(left: Uint8Array | undefined, right: Uint8Array): boolean {
  return left?.length === right.length && left.every((byte, index) => byte === right[index]);
}

async function response(url: URL): Promise<Response> {
  const result = await fetch(url);
  if (!result.ok) throw new Error(`Python payload fetch failed: ${url} (${result.status})`);
  return result;
}

async function manifest(options: PythonPayloadOptions, url: URL): Promise<PythonPayloadManifest> {
  const source = options.payload;
  if (source) return parsePythonPayloadManifest(typeof source === "function" ? await source() : source);
  const value: unknown = await (await response(url)).json();
  return parsePythonPayloadManifest(value);
}

async function fetchFile(file: PythonPayloadFile, base: URL): Promise<PayloadFile> {
  const bytes = new Uint8Array(await (await response(new URL(file.url, base))).arrayBuffer());
  if (bytes.byteLength !== file.bytes)
    throw new Error(`Python payload byte count mismatch: ${file.path}`);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (sha256 !== file.sha256) throw new Error(`Python payload hash mismatch: ${file.path}`);
  return { path: file.path, bytes };
}

function failures(results: readonly PromiseSettledResult<unknown>[]): unknown[] {
  return results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
}

/** Python-only payload ownership; the family entry owns raw-source caching. */
export function createPythonPayload(runtime: PythonPayloadRuntime, options: PythonPayloadOptions) {
  return new PythonPayload(runtime, options);
}

class PythonPayload {
  private readonly url: URL;
  private readonly owned = new Map<string, PayloadFile>();
  private closed = false;
  private active: Promise<Uint8Array> | undefined;
  private disposal: Promise<void> | undefined;

  private readonly runtime: PythonPayloadRuntime;
  private readonly options: PythonPayloadOptions;

  constructor(runtime: PythonPayloadRuntime, options: PythonPayloadOptions) {
    this.runtime = runtime;
    this.options = options;
    this.url = new URL(
      options.payloadUrl ?? new URL("../assets/python-stdlib.json", import.meta.url),
      globalThis.document?.baseURI ?? import.meta.url,
    );
  }

  private live(): void {
    if (this.closed || this.runtime.disposed) throw new Error("Python installation is disposed");
  }

  private async fetchWorker(entries: IterableIterator<PythonPayloadFile>, loaded: PayloadFile[]) {
    for (const file of entries) {
      this.live();
      loaded.push(await fetchFile(file, this.url));
    }
  }

  private async fetchFiles(files: readonly PythonPayloadFile[]): Promise<PayloadFile[]> {
    const entries = files.values();
    const loaded: PayloadFile[] = [];
    const workers = Array.from({ length: Math.min(8, files.length) }, () =>
      this.fetchWorker(entries, loaded),
    );
    const errors = failures(await Promise.allSettled(workers));
    if (errors.length) throw new AggregateError(errors, "Python payload loading failed");
    return loaded;
  }

  private async prepareDirectories(path: string): Promise<void> {
    for (const parent of parents(path)) {
      this.live();
      const entry = await this.runtime.filesystem.lookup(parent);
      if (entry && entry.kind !== "dir")
        throw new Error(`Python payload directory collision: ${parent}`);
    }
    this.live();
    await this.runtime.filesystem.mkdirp(path.slice(0, path.lastIndexOf("/")));
  }

  private async populate(file: PayloadFile): Promise<void> {
    await this.prepareDirectories(file.path);
    this.live();
    const entry = await this.runtime.filesystem.lookup(file.path);
    if (entry) {
      if (entry.kind !== "file") throw new Error(`Python payload collision: ${file.path}`);
      this.live();
      if (!sameBytes(await this.runtime.filesystem.readFile(file.path), file.bytes))
        throw new Error(`Python payload collision: ${file.path}`);
      return;
    }
    this.live();
    await this.runtime.filesystem.writeFile(file.path, file.bytes, { exclusive: true });
    this.owned.set(file.path, file);
  }

  private async removeFile(file: PayloadFile): Promise<void> {
    if (this.runtime.disposed) return;
    const entry = await this.runtime.filesystem.lookup(file.path);
    if (this.runtime.disposed || entry?.kind !== "file") return;
    const bytes = await this.runtime.filesystem.readFile(file.path);
    if (this.runtime.disposed || !sameBytes(bytes, file.bytes)) return;
    await this.runtime.filesystem.remove(file.path);
  }

  private async cleanup(): Promise<void> {
    if (!this.owned.size) return;
    const errors: unknown[] = [];
    for (const [path, file] of this.owned) {
      try {
        await this.removeFile(file);
        this.owned.delete(path);
      } catch (error) {
        errors.push(error);
      }
    }
    if (!this.runtime.disposed)
      await this.runtime.filesystem.drain().catch((error: unknown) => errors.push(error));
    if (errors.length) throw new AggregateError(errors, "Python payload cleanup failed");
  }

  private async populatePayload(): Promise<void> {
    const metadata = await manifest(this.options, this.url);
    this.live();
    const files = await this.fetchFiles(metadata.files);
    for (const file of files) await this.populate(file);
    this.live();
    await this.runtime.filesystem.drain();
    this.live();
  }

  private async prepare(source: () => Promise<Uint8Array>): Promise<Uint8Array> {
    const [interpreter, tree] = await Promise.allSettled([source(), this.populatePayload()]);
    const errors = failures([interpreter, tree]);
    if (
      !this.closed &&
      !this.runtime.disposed &&
      interpreter.status === "fulfilled" &&
      tree.status === "fulfilled"
    )
      return interpreter.value;
    if (!errors.length) errors.push(new Error("Python installation is disposed"));
    await this.cleanup().catch((error: unknown) => errors.push(error));
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, "Python preparation failed");
  }

  load(source: () => Promise<Uint8Array>): Promise<Uint8Array> {
    try {
      this.live();
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.active) return this.active;
    const attempt = this.prepare(source);
    this.active = attempt;
    const clear = () => {
      if (this.active === attempt) this.active = undefined;
    };
    void attempt.then(clear, clear);
    return attempt;
  }

  dispose(): Promise<void> {
    this.closed = true;
    this.disposal ??= this.finishDisposal();
    return this.disposal;
  }

  private async finishDisposal(): Promise<void> {
    await this.active?.catch(() => {});
    await this.cleanup();
  }
}
