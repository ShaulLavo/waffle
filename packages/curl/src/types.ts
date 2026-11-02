export class CurlError extends Error {
  constructor(
    readonly exit: number,
    message: string,
  ) {
    super(message);
    this.name = "CurlError";
  }
}

/** Each operation must settle on signal abortion and stop touching its borrowed resources. */
export interface CurlOutput {
  write(bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  close(signal: AbortSignal): Promise<void>;
  abort(reason: unknown): Promise<void>;
}

export interface CurlInvocation {
  readonly argv: readonly string[];
  readonly signal: AbortSignal;
  /** Mandatory finite overall ceiling, including input and output. -m may shorten it. */
  readonly timeoutMs: number;
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly stdin: ReadableStream<Uint8Array>;
  readonly stdout: CurlOutput;
  readonly stderr: (text: string) => Promise<void>;
  /** These are guest filesystem capabilities, never a path to the host filesystem. */
  readonly files: {
    read(path: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
    write(path: string, signal: AbortSignal): Promise<CurlOutput>;
  };
}

export interface DataPart {
  readonly value: string;
  readonly binary: boolean;
}

export interface CurlRequest {
  readonly url: URL;
  readonly method: string;
  readonly head: boolean;
  readonly include: boolean;
  readonly fail: boolean;
  readonly silent: boolean;
  readonly showError: boolean;
  readonly follow: boolean;
  readonly headers: Headers;
  readonly data: readonly DataPart[];
  readonly output: string | undefined;
  readonly timeoutMs: number | undefined;
}
