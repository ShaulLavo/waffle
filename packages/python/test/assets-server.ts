import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

export interface TestServer {
  readonly origin: string;
  close(): Promise<void>;
}

function contentType(path: string): string {
  if (path.endsWith(".wasm")) return "application/wasm";
  if (path.endsWith(".js")) return "text/javascript";
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

export async function serveTestFiles(root: string): Promise<TestServer> {
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const path = resolve(root, `.${decodeURIComponent(pathname)}`);
    if (path !== root && !path.startsWith(root + sep)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const bytes = await readFile(path);
      response.writeHead(200, {
        "Content-Type": contentType(path),
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cache-Control": "no-store",
      });
      response.end(bytes);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server has no TCP address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    },
  };
}
