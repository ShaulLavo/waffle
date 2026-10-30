export { runCurl } from "./curl.ts";
export { parseCurl } from "./parse.ts";
export type { CurlInvocation, CurlOutput, CurlRequest } from "./types.ts";

import type { CurlInvocation } from "./types.ts";

export const curlPaths = Object.freeze(["/usr/bin/curl", "/bin/curl"]);

/** Package-domain lifecycle only. This is NOT a Waffle executable registration. */
export function createCurlCommand() {
  const stop = new AbortController();
  const active = new Set<Promise<number>>();
  let source: Promise<typeof import("./curl.ts")> | undefined;
  let disposal: Promise<void> | undefined;
  return {
    paths: curlPaths,
    run(invocation: CurlInvocation): Promise<number> {
      if (stop.signal.aborted) return Promise.reject(new Error("curl command is disposed"));
      const signal = AbortSignal.any([invocation.signal, stop.signal]);
      source ??= import("./curl.ts");
      const running = source.then(({ runCurl }) => runCurl({ ...invocation, signal }));
      active.add(running);
      void running.finally(() => active.delete(running)).catch(() => {});
      return running;
    },
    dispose(): Promise<void> {
      stop.abort();
      disposal ??= Promise.allSettled(active).then(() => {});
      return disposal;
    },
  };
}
