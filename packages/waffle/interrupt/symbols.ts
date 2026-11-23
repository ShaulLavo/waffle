import { sha256Hex } from "./admitted-store.js";
import { admittedModuleDiagnostics, type AdmittedModuleDiagnostics } from "./diagnostics.js";

export const DEFAULT_MAX_SIDECAR_BYTES = 4 * 1024 * 1024;
export const DEFAULT_FETCH_TIMEOUT_MS = 5_000;

export type FrameEngine = "chromium" | "firefox" | "webkit";

export interface OwnedWasmFrame {
  readonly engine: FrameEngine;
  readonly nonce: string;
  readonly functionIndex: number;
}

export interface WasmSymbolSidecarIdentity {
  readonly bytes: number;
  readonly sha256: string;
}

export interface WasmSymbolSidecar {
  readonly version: 1;
  readonly source: WasmSymbolSidecarIdentity;
  readonly named: WasmSymbolSidecarIdentity;
  readonly importedFunctions: number;
  readonly names: readonly (string | null)[];
}

export interface SymbolSidecarSource {
  readonly url: string | URL;
  /** Optional exact sidecar byte length (as exported by `@waffle-os/coreutils/symbols/*`). */
  readonly bytes?: number;
  /** Trusted SHA-256 hex digest of the sidecar JSON bytes, supplied outside the sidecar. */
  readonly sha256: string;
}

export type SymbolSidecarFetch = (
  input: string | URL,
  init?: { readonly signal?: AbortSignal },
) => Promise<Response>;

export interface LoadSymbolSidecarOptions {
  /** Maximum allowed sidecar byte size (default 4 MiB). */
  readonly maxBytes?: number;
  /** Maximum fetch duration in milliseconds (default 5000). */
  readonly timeoutMs?: number;
  /** Custom fetch implementation for tests or embedded hosts. */
  readonly fetch?: SymbolSidecarFetch;
  /** Optional AbortSignal to cancel the fetch. */
  readonly signal?: AbortSignal;
}

export interface SymbolTable {
  readonly diagnostics: AdmittedModuleDiagnostics;
  readonly sidecar: WasmSymbolSidecar;
  /** Reverse the interrupt-rewriter import shift and return the original function name, or undefined. */
  lookup(admittedFunctionIndex: number): string | undefined;
}

export interface AnnotateStackOptions {
  /** Restrict matching to one engine grammar; omit to accept all three browser formats. */
  readonly engine?: FrameEngine;
}

export interface AnnotatedStack {
  /** Stack text with matched owned frames annotated and all other lines preserved verbatim. */
  readonly stack: string;
  /** Number of owned frames annotated across all supplied symbol tables. */
  readonly annotatedFrames: number;
}

export interface ModuleSymbolBinding {
  readonly module: WebAssembly.Module | AdmittedModuleDiagnostics;
  readonly sidecar: SymbolSidecarSource;
}

export interface AnnotateErrorOptions extends LoadSymbolSidecarOptions, AnnotateStackOptions {}

export interface AnnotatedErrorResult<E = unknown> {
  /** Exact original error value, never mutated or replaced. */
  readonly error: E;
  /** Annotated stack text when available, or raw error stack unchanged. */
  readonly stack: string;
  /** Number of owned frames annotated (0 on any failure or when diagnostics are disabled). */
  readonly annotatedFrames: number;
}

const SHA256_HEX = /^[a-f0-9]{64}$/;
const SAFE_NONCE = /^[A-Za-z0-9_]+$/;
const CONTROL_CHAR = /[\r\n\0]/;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// Engine-specific grammars for unnamed Wasm frames carrying only subsection-0 module name:
//   Chromium (V8):  `    at <nonce> (wasm://wasm/<nonce>-<8hex>:wasm-function[N]:0x...)`
//   Firefox (SM):   `<nonce>.@<url-or-empty>:wasm-function[N]:0x...`
//   WebKit (JSC):   `@<nonce>:wasm-function[N]`
const V8_OWNED_FRAME =
  /^(\s*at )([A-Za-z0-9_]+)( \(wasm:\/\/wasm\/\2-[0-9a-f]{8}:wasm-function\[(0|[1-9]\d*)\]:0x[0-9a-f]+\))$/;
const FIREFOX_OWNED_FRAME =
  /^(\s*)([A-Za-z0-9_]+)\.@([^@]*:wasm-function\[(0|[1-9]\d*)\]:0x[0-9a-f]+)$/;
const WEBKIT_OWNED_FRAME = /^(\s*)@([A-Za-z0-9_]+)(:wasm-function\[(0|[1-9]\d*)\])$/;

interface ParsedOwnedLine {
  readonly engine: FrameEngine;
  readonly nonce: string;
  readonly functionIndex: number;
  readonly format: (symbolName: string) => string;
}

function parseOwnedLine(line: string, engine?: FrameEngine): ParsedOwnedLine | null {
  if (!engine || engine === "chromium") {
    const match = V8_OWNED_FRAME.exec(line);
    if (match) {
      const index = Number(match[4]);
      if (Number.isSafeInteger(index)) {
        const prefix = match[1]!;
        const nonce = match[2]!;
        const suffix = match[3]!;
        return {
          engine: "chromium",
          nonce,
          functionIndex: index,
          format: (symbol) => `${prefix}${nonce}.${symbol}${suffix}`,
        };
      }
    }
  }
  if (!engine || engine === "firefox") {
    const match = FIREFOX_OWNED_FRAME.exec(line);
    if (match) {
      const index = Number(match[4]);
      if (Number.isSafeInteger(index)) {
        const indent = match[1]!;
        const nonce = match[2]!;
        const rest = match[3]!;
        return {
          engine: "firefox",
          nonce,
          functionIndex: index,
          format: (symbol) => `${indent}${nonce}.${symbol}@${rest}`,
        };
      }
    }
  }
  if (!engine || engine === "webkit") {
    const match = WEBKIT_OWNED_FRAME.exec(line);
    if (match) {
      const index = Number(match[4]);
      if (Number.isSafeInteger(index)) {
        const indent = match[1]!;
        const nonce = match[2]!;
        const rest = match[3]!;
        return {
          engine: "webkit",
          nonce,
          functionIndex: index,
          format: (symbol) => `${indent}${symbol}@${nonce}${rest}`,
        };
      }
    }
  }
  return null;
}

/**
 * Fail-closed frame ownership parser. Matches ONLY unnamed Wasm frames whose engine-emitted
 * module token equals `expectedNonce`. Already-named frames, unnamed-module frames, JS frames,
 * other modules, and truncated lines return `null`.
 */
export function matchOwnedWasmFrame(
  line: string,
  expectedNonce: string,
  engine?: FrameEngine,
): OwnedWasmFrame | null {
  if (!SAFE_NONCE.test(expectedNonce)) return null;
  const parsed = parseOwnedLine(line, engine);
  if (!parsed || parsed.nonce !== expectedNonce) return null;
  return {
    engine: parsed.engine,
    nonce: parsed.nonce,
    functionIndex: parsed.functionIndex,
  };
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function parseIdentity(value: unknown): WasmSymbolSidecarIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!isNonNegativeInt(record.bytes)) return undefined;
  if (typeof record.sha256 !== "string" || !SHA256_HEX.test(record.sha256)) return undefined;
  return { bytes: record.bytes, sha256: record.sha256 };
}

function validateNamesArray(value: unknown): readonly (string | null)[] | undefined {
  if (!Array.isArray(value)) return undefined;
  for (let i = 0; i < value.length; i++) {
    const entry: unknown = value[i];
    if (entry === null) continue;
    if (typeof entry !== "string" || entry.length === 0 || CONTROL_CHAR.test(entry))
      return undefined;
  }
  return value as readonly (string | null)[];
}

function validateSidecarObject(value: unknown, rawText: string): WasmSymbolSidecar | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return undefined;
  const source = parseIdentity(record.source);
  const named = parseIdentity(record.named);
  if (!source || !named) return undefined;
  if (!isNonNegativeInt(record.importedFunctions)) return undefined;
  const names = validateNamesArray(record.names);
  if (!names) return undefined;
  const canonical: WasmSymbolSidecar = {
    version: 1,
    source,
    named,
    importedFunctions: record.importedFunctions,
    names,
  };
  if (JSON.stringify(canonical) !== rawText) return undefined;
  return canonical;
}

function ownedArrayBufferBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes as Uint8Array<ArrayBuffer>;
  }
  return new Uint8Array(bytes);
}

/** Verify sidecar bytes against a caller-supplied trusted SHA-256 (and optional exact byte size) and parse the schema. */
export async function parseSymbolSidecar(
  bytes: Uint8Array,
  trustedSha256: string,
  expectedBytes?: number,
): Promise<WasmSymbolSidecar | undefined> {
  if (typeof trustedSha256 !== "string" || !SHA256_HEX.test(trustedSha256)) return undefined;
  if (expectedBytes !== undefined) {
    if (!isNonNegativeInt(expectedBytes) || bytes.byteLength !== expectedBytes) return undefined;
  }
  try {
    const owned = ownedArrayBufferBytes(bytes);
    const actualSha256 = await sha256Hex(owned);
    if (actualSha256 !== trustedSha256) return undefined;
    const rawText = utf8Decoder.decode(owned);
    const parsed: unknown = JSON.parse(rawText);
    return validateSidecarObject(parsed, rawText);
  } catch {
    return undefined;
  }
}

/** Bind a validated sidecar to recorded admission diagnostics, verifying source hash and layout. */
export function bindSymbolSidecar(
  diagnostics: AdmittedModuleDiagnostics,
  sidecar: WasmSymbolSidecar,
): SymbolTable | undefined {
  const expectedAdded = diagnostics.profile === "supervised-thread" ? 3 : 1;
  if (diagnostics.addedImports !== expectedAdded) return undefined;
  if (!SAFE_NONCE.test(diagnostics.nonce)) return undefined;
  if (sidecar.source.sha256 !== diagnostics.sourceSha256) return undefined;
  if (sidecar.importedFunctions !== diagnostics.originalImports) return undefined;
  if (sidecar.names.length !== diagnostics.originalDefinitions) return undefined;
  const firstDefinition = diagnostics.originalImports + diagnostics.addedImports;
  const definitions = diagnostics.originalDefinitions;
  const names = sidecar.names;
  return Object.freeze({
    diagnostics,
    sidecar,
    lookup(admittedFunctionIndex: number): string | undefined {
      if (!Number.isSafeInteger(admittedFunctionIndex)) return undefined;
      const defIndex = admittedFunctionIndex - firstDefinition;
      if (defIndex < 0 || defIndex >= definitions) return undefined;
      const symbol = names[defIndex];
      return typeof symbol === "string" && symbol.length > 0 ? symbol : undefined;
    },
  });
}

function rejectsDeclaredLength(
  response: Response,
  maxBytes: number,
  expectedBytes: number | undefined,
): boolean {
  const header = response.headers.get("content-length");
  if (!header) return false;
  const declared = Number(header.trim());
  if (!Number.isFinite(declared)) return false;
  if (declared > maxBytes) return true;
  return expectedBytes !== undefined && declared !== expectedBytes;
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  expectedBytes: number | undefined,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (rejectsDeclaredLength(response, maxBytes, expectedBytes)) {
    await response.body?.cancel?.().catch(() => {});
    return undefined;
  }
  const limit = expectedBytes !== undefined ? Math.min(maxBytes, expectedBytes) : maxBytes;
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > limit) return undefined;
    if (expectedBytes !== undefined && buffer.byteLength !== expectedBytes) return undefined;
    return new Uint8Array(buffer);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      const chunk = step.value;
      total += chunk.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  if (expectedBytes !== undefined && total !== expectedBytes) return undefined;
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

/** Fetch sidecar bytes with strict byte-size and timeout bounds. Never throws; returns undefined on failure. */
export async function fetchSymbolSidecar(
  source: SymbolSidecarSource,
  options: LoadSymbolSidecarOptions = {},
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (typeof source.sha256 !== "string" || !SHA256_HEX.test(source.sha256)) return undefined;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_SIDECAR_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  if (!isPositiveInt(maxBytes) || !isPositiveInt(timeoutMs)) return undefined;
  const expectedBytes = source.bytes;
  if (expectedBytes !== undefined && (!isNonNegativeInt(expectedBytes) || expectedBytes > maxBytes))
    return undefined;
  const fetchFn = options.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== "function") return undefined;
  if (options.signal?.aborted) return undefined;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(source.url, { signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      return undefined;
    }
    return await readBoundedResponse(response, maxBytes, expectedBytes);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

function resolveDiagnostics(
  moduleOrDiagnostics: WebAssembly.Module | AdmittedModuleDiagnostics,
): AdmittedModuleDiagnostics | undefined {
  if (moduleOrDiagnostics instanceof WebAssembly.Module)
    return admittedModuleDiagnostics(moduleOrDiagnostics);
  return moduleOrDiagnostics;
}

/**
 * Fetch, digest-verify, parse, and bind a symbol sidecar for one admitted module.
 * Performs no fetch and returns `undefined` if diagnostics were disabled for the module.
 */
export async function loadSymbolTable(
  moduleOrDiagnostics: WebAssembly.Module | AdmittedModuleDiagnostics,
  source: SymbolSidecarSource,
  options?: LoadSymbolSidecarOptions,
): Promise<SymbolTable | undefined> {
  const diagnostics = resolveDiagnostics(moduleOrDiagnostics);
  if (!diagnostics) return undefined;
  const bytes = await fetchSymbolSidecar(source, options);
  if (!bytes) return undefined;
  const sidecar = await parseSymbolSidecar(bytes, source.sha256, source.bytes);
  if (!sidecar) return undefined;
  return bindSymbolSidecar(diagnostics, sidecar);
}

/**
 * Annotate owned unnamed Wasm frames in `stack` using verified `SymbolTable`s.
 * Unmatched lines, other modules, already-named frames, and truncated lines stay verbatim.
 */
export function annotateStack(
  stack: string,
  tables: readonly SymbolTable[],
  options: AnnotateStackOptions = {},
): AnnotatedStack {
  if (!stack || tables.length === 0) return { stack, annotatedFrames: 0 };
  const byNonce = new Map<string, SymbolTable>();
  for (const table of tables) {
    if (SAFE_NONCE.test(table.diagnostics.nonce)) byNonce.set(table.diagnostics.nonce, table);
  }
  if (byNonce.size === 0) return { stack, annotatedFrames: 0 };
  const lines = stack.split("\n");
  let annotatedFrames = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const hasCR = raw.endsWith("\r");
    const line = hasCR ? raw.slice(0, -1) : raw;
    const parsed = parseOwnedLine(line, options.engine);
    if (!parsed) continue;
    const table = byNonce.get(parsed.nonce);
    if (!table) continue;
    const symbol = table.lookup(parsed.functionIndex);
    if (!symbol) continue;
    lines[i] = hasCR ? `${parsed.format(symbol)}\r` : parsed.format(symbol);
    annotatedFrames++;
  }
  return { stack: lines.join("\n"), annotatedFrames };
}

function readRawStack(error: unknown): string {
  try {
    if (error instanceof Error && typeof error.stack === "string") return error.stack;
    return "";
  } catch {
    return "";
  }
}

/**
 * Lazily fetch sidecars for admitted diagnostic modules referenced in `error`'s stack
 * and return annotated stack text while always preserving the original `error` untouched.
 */
export async function annotateError<E>(
  error: E,
  bindings: readonly ModuleSymbolBinding[],
  options: AnnotateErrorOptions = {},
): Promise<AnnotatedErrorResult<E>> {
  const rawStack = readRawStack(error);
  if (!rawStack || bindings.length === 0) {
    return { error, stack: rawStack, annotatedFrames: 0 };
  }
  const candidates: Array<{
    readonly diagnostics: AdmittedModuleDiagnostics;
    readonly sidecar: SymbolSidecarSource;
  }> = [];
  for (const binding of bindings) {
    const diagnostics = resolveDiagnostics(binding.module);
    if (!diagnostics || !rawStack.includes(diagnostics.nonce)) continue;
    candidates.push({ diagnostics, sidecar: binding.sidecar });
  }
  if (candidates.length === 0) {
    return { error, stack: rawStack, annotatedFrames: 0 };
  }
  const loaded = await Promise.all(
    candidates.map((candidate) =>
      loadSymbolTable(candidate.diagnostics, candidate.sidecar, options),
    ),
  );
  const tables = loaded.filter((table): table is SymbolTable => table !== undefined);
  const annotated = annotateStack(rawStack, tables, options);
  return { error, stack: annotated.stack, annotatedFrames: annotated.annotatedFrames };
}
