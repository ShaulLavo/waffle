import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { CurlInvocation } from "../src/types.ts";

const module: unknown = await import(
  pathToFileURL(resolve(import.meta.dir, "../dist/curl.js")).href
);
if (
  !module ||
  typeof module !== "object" ||
  !("runCurl" in module) ||
  typeof module.runCurl !== "function"
)
  throw new Error("built curl library does not export runCurl");
let stdout = "";
const invocation: CurlInvocation = {
  argv: ["https://fixture.invalid/"],
  signal: new AbortController().signal,
  timeoutMs: 1000,
  fetch: async () => new Response("bundle smoke\n"),
  stdin: new Blob([]).stream(),
  stdout: {
    async write(bytes) {
      stdout += new TextDecoder().decode(bytes);
    },
    async close() {
      throw new Error("borrowed stdout closed");
    },
    async abort() {
      throw new Error("borrowed stdout aborted");
    },
  },
  async stderr() {
    throw new Error("unexpected bundle diagnostic");
  },
  files: {
    async read() {
      throw new Error("unexpected file read");
    },
    async write() {
      throw new Error("unexpected file write");
    },
  },
};
const code: unknown = await module.runCurl(invocation);
if (code !== 0 || stdout !== "bundle smoke\n")
  throw new Error("built curl library behavior differs");
console.log(
  "Built portable library smoke passed. Actual Waffle runtime admission remains BLOCKED.",
);
