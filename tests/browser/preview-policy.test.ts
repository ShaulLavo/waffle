import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { buildClassicWorker } from "../../scripts/browser-build";

let directory: string;
let source: string;
beforeAll(async () => {
  directory = await mkdtemp(join(process.env.BUN_WASM_TEST_TMP ?? process.env.TMPDIR ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir()), "bun-wasm-preview-policy-"));
  const result = await buildClassicWorker(join(import.meta.dir, "../src/sw.ts"), directory, { __PREVIEW_SOCKET_SCRIPT__: JSON.stringify("socket adapter") });
  expect(result.outputs).toHaveLength(1);
  source = await result.outputs[0]!.text();
});
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

function worker(base: string, mount: string, contentType = "text/html", encoding?: string) {
  const handlers = new Map<string, (event: any) => void>();
  const cached = new Map<string, Response>();
  const requests: string[] = [];
  const scope = `${base}${mount}/`;
  const page = {
    url: `${base}index.html`,
    postMessage(_ask: unknown, ports: MessagePort[]) {
      const port = ports[0]!;
      const headers = [["content-type", contentType]];
      if (encoding) headers.push(["content-encoding", encoding]);
      port.postMessage({ type: "head", status: 200, statusText: "OK", headers });
      port.postMessage({ type: "data", chunk: new TextEncoder().encode("<!doctype html><html>preview</html>") });
      port.postMessage({ type: "end" });
      port.close();
    },
  };
  const clients = { async matchAll() { return [page]; }, async get() { return undefined; }, async claim() {} };
  runInNewContext(source, {
    self: { registration: { scope }, clients, addEventListener(type: string, handler: (event: any) => void) { handlers.set(type, handler); } },
    location: { origin: new URL(base).origin },
    caches: { async match(request: Request) { return cached.get(request.url); } },
    async fetch(request: Request | string) { requests.push(typeof request === "string" ? request : request.url); return new Response("app chunk"); },
    URL, Response, Request, Headers, ReadableStream, TextEncoder, TextDecoder, MessageChannel, Uint8Array, setTimeout, clearTimeout,
  });
  return {
    cached, requests,
    fetch(path: string, clientId = ""): Promise<Response> | undefined {
      let response: Promise<Response> | undefined;
      handlers.get("fetch")!({ request: new Request(`${base}${path}`), clientId, respondWith(value: Response | Promise<Response>) { response = Promise.resolve(value); } });
      return response;
    },
  };
}

test("Bun service worker still builds as one standalone classic script", () => {
  expect(new Bun.Transpiler({ loader: "js" }).scan(source).imports).toEqual([]);
  expect(source).not.toMatch(/\bexport\s/);
});

for (const base of ["https://example.test/", "https://example.test/nested/app/"]) {
  test(`Bun module cache and scoped chunks stay consumer policy at ${base}`, async () => {
    const sw = worker(base, "__bunwasm");
    sw.cached.set(`${base}__bunwasm/m/run/key`, new Response("cached module"));
    expect(await (await sw.fetch("__bunwasm/m/run/key"))?.text()).toBe("cached module");
    expect((await sw.fetch("__bunwasm/m/missing/key"))?.status).toBe(404);
    const chunk = await sw.fetch("__bunwasm/chunks/shared.js");
    expect(await chunk?.text()).toBe("app chunk");
    expect(chunk?.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(chunk?.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(sw.requests).toEqual([`${base}chunks/shared.js`]);
    expect(sw.fetch("unrelated.js")).toBeUndefined();
  });

  test(`Bun preview script injection and isolation headers stay consumer policy at ${base}`, async () => {
    const sw = worker(base, "__preview");
    const response = await sw.fetch("__preview/8123/page");
    expect(response?.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(response?.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    const prefix = new URL(`${base}__preview/`).pathname;
    expect(await response?.text()).toBe(`<!doctype html><script src="${new URL(base).pathname}preview-websocket.js" data-bun-port="8123" data-bun-prefix="${prefix}"></script><html>preview</html>`);
    const script = await sw.fetch("preview-websocket.js");
    expect(script?.headers.get("content-type")).toBe("text/javascript");
    expect(await script?.text()).toBe("socket adapter");
  });
}

test("Bun websocket script policy does not rewrite encoded or non-HTML responses", async () => {
  for (const [contentType, encoding] of [["application/json", undefined], ["text/html", "gzip"]]) {
    const sw = worker("https://example.test/", "__preview", contentType, encoding);
    const response = await sw.fetch("__preview/8123/");
    expect(await response?.text()).toBe("<!doctype html><html>preview</html>");
    expect(response?.headers.get("cross-origin-embedder-policy")).toBeNull();
  }
});
