import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, createServer, preview, type ViteDevServer, type PreviewServer } from "vite";
import { createRuntime } from "../index.js";
import { PreviewRouter } from "../browser/preview.js";
import { createPreviewServiceWorker } from "../browser/service-worker.js";
import type { PreviewReply } from "../browser/preview-protocol.js";
import type { PreviewHostRelay } from "../browser/preview-host.js";
import { previewNetworkFixture } from "./preview-network-fixture.js";
import { startPreviewReferenceHost } from "./preview-host-reference.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const baseURL = "https://playground.example.test/playground/";
const scope = `${baseURL}__preview/`;

async function deadline<T>(work: Promise<T>, label: string): Promise<T> {
  const expired = Promise.withResolvers<never>();
  const timer = setTimeout(() => expired.reject(Error(`Timed out: ${label}`)), 5000);
  try {
    return await Promise.race([work, expired.promise]);
  } finally {
    clearTimeout(timer);
  }
}

function mountedWorker(router: PreviewRouter, port: number) {
  const owner = {
    url: baseURL,
    postMessage: (data: Parameters<PreviewRouter["onMessage"]>[0]["data"], ports: MessagePort[]) =>
      router.onMessage({ data, ports }),
  };
  return createPreviewServiceWorker({
    scope,
    clients: {
      async get() {
        return { ...owner, url: `${scope}${port}/` };
      },
      async matchAll() {
        return [owner];
      },
    },
    fetch: async () => {
      throw Error("Preview escaped to external fetch");
    },
  });
}

function nativePort(server: ViteDevServer["httpServer"]): number {
  const address = server?.address();
  if (!address || typeof address === "string") throw Error("No native Vite listener");
  return address.port;
}

async function checkRoutes(
  worker: ReturnType<typeof mountedWorker>,
  router: PreviewRouter,
  hostURL: string,
  port: number,
  path: string,
  content: string,
) {
  for (const client of ["", "embedded"]) {
    const url = client ? new URL(path, scope).href : router.url(port, path);
    const response = await deadline(Promise.resolve(worker.fetch(new Request(url), client)), url);
    expect(response?.status).toBe(200);
    expect(await deadline(Promise.resolve(response?.text()), `body ${url}`)).toContain(content);
  }
  const response = await fetch(new URL(path, hostURL), { signal: AbortSignal.timeout(5000) });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain(content);
}

async function checkUpgrade(relay: PreviewHostRelay, token: string): Promise<void> {
  const received = Promise.withResolvers<string>();
  let output = "";
  const connection = relay.connect(
    relay.authorization,
    {
      url: `${relay.origin}/?token=${token}`,
      method: "GET",
      headers: [
        ["Origin", relay.origin],
        ["Connection", "Upgrade"],
        ["Upgrade", "websocket"],
        ["Sec-WebSocket-Version", "13"],
        ["Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="],
        ["Sec-WebSocket-Protocol", "vite-hmr"],
      ],
    },
    {
      data(bytes) {
        output += decoder.decode(bytes);
        if (output.includes('"type":"connected"')) received.resolve(output);
      },
      end() {
        received.reject(Error(`Upgrade ended before Vite connected: ${output}`));
      },
      error(message) {
        received.reject(Error(message));
      },
    },
  );
  try {
    expect(connection).not.toBeNull();
    const response = await deadline(received.promise, "root upgrade");
    expect(response).toStartWith("HTTP/1.1 101 Switching Protocols\r\n");
    expect(response).toContain("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    expect(response).toContain("Sec-WebSocket-Protocol: vite-hmr");
  } finally {
    connection?.close();
  }
}

async function checkMountedUpgrade(worker: ReturnType<typeof mountedWorker>, port: number) {
  const channel = new MessageChannel();
  const received = Promise.withResolvers<string>();
  let output = "";
  channel.port1.onmessage = ({ data }: MessageEvent<PreviewReply>) => {
    if (data.type === "accepted")
      channel.port1.postMessage({
        type: "data",
        chunk: encoder.encode(
          `GET / HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: vite-hmr\r\n\r\n`,
        ),
      });
    if (data.type === "data") output += decoder.decode(data.chunk);
    if (output.includes('"type":"connected"')) received.resolve(output);
    if (data.type === "error") received.reject(Error(data.message));
  };
  try {
    await worker.socket(port, `${scope}${port}/`, channel.port2);
    expect(await deadline(received.promise, "mounted upgrade")).toStartWith(
      "HTTP/1.1 101 Switching Protocols\r\n",
    );
    channel.port1.postMessage({ type: "end" });
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
}

async function closePreview(server: PreviewServer | undefined) {
  if (!server) return;
  if ("closeAllConnections" in server.httpServer) server.httpServer.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.httpServer.close((error) => (error ? reject(error) : resolve())),
  );
}

test("stock Vite 8 dev and preview use virtual listeners through standalone, embedded and root routes", async () => {
  const root = await mkdtemp(join(process.env.NETWORK_SCRATCH_ROOT ?? tmpdir(), "waffle-vite-"));
  const runtime = createRuntime({
    filesystem: { workerURL: new URL("../browser/fs-worker.ts", import.meta.url), mode: "memory" },
    processHost() {
      throw Error("Preview activated processes");
    },
  });
  const mounted = new PreviewRouter({ baseURL, prefix: "__preview" });
  const origins = new Map<number, string>();
  const roots = new PreviewRouter({
    mode: "root",
    originForPort: (port) => origins.get(port) ?? "",
  });
  const bridges: ReturnType<typeof previewNetworkFixture>[] = [];
  const hosts: Awaited<ReturnType<typeof startPreviewReferenceHost>>[] = [];
  let dev: ViteDevServer | undefined;
  let production: PreviewServer | undefined;
  try {
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeFile(
      join(root, "index.html"),
      '<div id="app">Vite transport</div><script type="module" src="/main.ts"></script>',
    );
    await writeFile(
      join(root, "main.ts"),
      'import "./style.css"; document.querySelector("#app")!.textContent = "stock-vite";',
    );
    await writeFile(join(root, "style.css"), "body { color: rgb(12, 34, 56); }");
    dev = await createServer({ root, logLevel: "silent", server: { host: "127.0.0.1", port: 0 } });
    await dev.listen();
    const network = await runtime.network();
    const development = previewNetworkFixture(
      network,
      [mounted, roots],
      nativePort(dev.httpServer),
      5173,
    );
    bridges.push(development);
    development.listen();
    expect(development.events).toEqual(["listening 5173"]);
    const host = await startPreviewReferenceHost({
      router: roots,
      port: 5173,
      allocated: (origin) => origins.set(5173, origin),
    });
    hosts.push(host);
    const worker = mountedWorker(mounted, 5173);
    await checkRoutes(worker, mounted, host.url.href, 5173, "/?value=a%2Bb", "Vite transport");
    await checkRoutes(worker, mounted, host.url.href, 5173, "/@vite/client", "WebSocket");
    await checkRoutes(worker, mounted, host.url.href, 5173, "/main.ts", "stock-vite");
    const relay = await roots.bindHost({ port: 5173 });
    await checkUpgrade(relay, dev.config.webSocketToken);
    await checkMountedUpgrade(worker, 5173);
    development.stopListening();
    expect(development.events).toEqual(["listening 5173", "stopped 5173"]);
    expect(mounted.serves(5173)).toBe(false);
    expect(roots.serves(5173)).toBe(false);
    expect(relay.closed).toBe(true);
    expect((await worker.fetch(new Request(mounted.url(5173)), ""))?.status).toBe(502);
    await dev.close();
    dev = undefined;
    await build({ root, logLevel: "silent" });
    production = await preview({
      root,
      logLevel: "silent",
      preview: { host: "127.0.0.1", port: 0 },
    });
    const built = previewNetworkFixture(
      network,
      [mounted, roots],
      nativePort(production.httpServer),
      4173,
    );
    bridges.push(built);
    built.listen();
    const previewHost = await startPreviewReferenceHost({
      router: roots,
      port: 4173,
      allocated: (origin) => origins.set(4173, origin),
    });
    hosts.push(previewHost);
    const previewWorker = mountedWorker(mounted, 4173);
    await checkRoutes(previewWorker, mounted, previewHost.url.href, 4173, "/", "Vite transport");
    const html = await (await previewWorker.fetch(new Request(mounted.url(4173)), ""))?.text();
    const assets = Array.from(
      html?.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g) ?? [],
      (match) => match[1]!,
    );
    expect(assets).toHaveLength(2);
    for (const asset of assets)
      await checkRoutes(
        previewWorker,
        mounted,
        previewHost.url.href,
        4173,
        asset,
        asset.endsWith(".css") ? "body" : "stock-vite",
      );
    await built.close();
    expect(built.events).toEqual(["listening 4173", "stopped 4173"]);
    expect(mounted.serves(4173)).toBe(false);
    expect((await previewWorker.fetch(new Request(mounted.url(4173)), "embedded"))?.status).toBe(
      502,
    );
    for (const bridge of bridges) {
      await bridge.close();
      expect(bridge.connections).toBe(0);
      expect(bridge.errors).toEqual([]);
    }
  } finally {
    for (const host of hosts) host.close();
    for (const bridge of bridges) await bridge.close();
    await closePreview(production);
    await dev?.close();
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
