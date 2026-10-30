import {
  createPythonPayload,
  PYTHON_ARGV0,
  type PythonPayloadOptions,
  type PythonPayloadRuntime,
} from "./python-payload.ts";
import { defineProgramPackage, type ProgramCatalog } from "waffle/programs/catalog";
import { pythonLauncher } from "./launcher.ts";

export const PYTHON_PATH = "/usr/bin/python";
export { PYTHON_ARGV0 };
export * from "./python-payload.ts";

export type PythonSource = Uint8Array | (() => Uint8Array | Promise<Uint8Array>);
export type PythonOptions = PythonPayloadOptions &
  (
    | { readonly wasmUrl?: string | URL; readonly source?: never }
    | { readonly source: PythonSource; readonly wasmUrl?: never }
  );

export type PythonRuntime = PythonPayloadRuntime;

/**
 * The family-owned part of a Waffle program installation. Waffle's package installer
 * adds the executable registration, generic preview1 adapter and argv0 launch policy.
 */
export interface PythonProgram {
  readonly name: "python";
  readonly path: typeof PYTHON_PATH;
  readonly argv0: typeof PYTHON_ARGV0;
  readonly source: () => Promise<Uint8Array>;
  dispose(): Promise<void>;
}

async function interpreter(options: PythonOptions): Promise<Uint8Array> {
  if (options.source instanceof Uint8Array) return options.source;
  if (options.source) return options.source();
  const url = new URL(
    options.wasmUrl ?? new URL("../assets/python.wasm", import.meta.url),
    globalThis.document?.baseURI ?? import.meta.url,
  );
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Python interpreter fetch failed: ${url} (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

function cachedLoad(load: () => Promise<Uint8Array>): () => Promise<Uint8Array> {
  let pending: Promise<Uint8Array> | undefined;
  return () => {
    if (pending) return pending;
    const attempt = load();
    pending = attempt;
    void attempt.catch(() => {
      if (pending === attempt) pending = undefined;
    });
    return attempt;
  };
}

/** Create lazy CPython source and stdlib preparation without creating a Runtime. */
export function createPythonProgram(
  runtime: PythonRuntime,
  options: PythonOptions = {},
): PythonProgram {
  const payload = createPythonPayload(runtime, options);
  return {
    name: "python",
    path: PYTHON_PATH,
    argv0: PYTHON_ARGV0,
    source: cachedLoad(() => payload.load(() => interpreter(options))),
    dispose: () => payload.dispose(),
  };
}

/** Adapt the family-owned payload to Waffle's generic lazy installer contract. */
export function createPythonPackage(
  runtime: PythonRuntime,
  options: PythonOptions = {},
): ProgramCatalog {
  const program = createPythonProgram(runtime, options);
  return defineProgramPackage({
    name: program.name,
    programs: [
      {
        path: program.path,
        aliases: ["/usr/bin/python3", "/bin/python3"],
        argv0: program.argv0,
        source: program.source,
        launch: (context, service, fallback) => pythonLauncher(fallback)(context, service),
      },
    ],
    dispose: program.dispose,
  });
}
