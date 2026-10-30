export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export interface Repository {
  readonly owner: string;
  readonly name: string;
}

export type QueryEntry = readonly [name: string, value: string];

export interface ApiRequest {
  readonly method: string;
  readonly path: string;
  readonly query?: readonly QueryEntry[];
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: JsonValue | Uint8Array;
}

export interface HttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

export interface FileSystem {
  readFile(path: string): Promise<Uint8Array | undefined>;
  writeFile(path: string, contents: Uint8Array, mode?: number): Promise<void>;
  mkdir(path: string): Promise<void>;
}

export type Evaluator = (
  expression: string,
  input: JsonValue,
  context: { readonly cwd: string; readonly env: Readonly<Record<string, string | undefined>> },
) => Promise<string>;

export interface Invocation {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdin: () => Promise<Uint8Array>;
  readonly stdout: (bytes: Uint8Array) => void | Promise<void>;
  readonly stderr: (bytes: Uint8Array) => void | Promise<void>;
  readonly filesystem: FileSystem;
  readonly transport: Transport;
  readonly evaluator?: Evaluator;
  readonly secrets?: Set<string>;
}
