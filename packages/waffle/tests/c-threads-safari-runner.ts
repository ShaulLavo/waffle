import { mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readCThreadsPacket } from "./c-threads-packet.js";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("expected Safari JSON object");
  return Object.fromEntries(Object.entries(value));
}
async function command(base: string, path: string, body?: unknown, method = "POST") {
  const options: RequestInit = {
    method,
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(method === "DELETE" ? 10_000 : 120_000),
  };
  if (body !== undefined) options.body = JSON.stringify(body);
  const response = await fetch(base + path, options);
  const result = object(await response.json());
  if (!response.ok) throw new Error(`Safari ${path}: ${JSON.stringify(result)}`);
  return result.value;
}
async function save(path: string, value: unknown) {
  const file = await open(path, "wx");
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
}
async function run(
  directory: string,
  digest: string,
  driver: string,
  port: number,
  output: string,
) {
  const manifest = await readCThreadsPacket(directory, digest);
  const assets = new Set(manifest.assets.map((asset) => asset.path));
  let session: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let cleaning: Promise<void> | undefined;
  const cleanup = () =>
    (cleaning ??= (async () => {
      try {
        if (session) await command(driver, `/session/${session}`, undefined, "DELETE");
      } finally {
        await server?.stop(true);
      }
    })());
  const stop = () => void cleanup().finally(() => process.exit(1));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const deadline = setTimeout(stop, 600_000);
  try {
    await mkdir(output);
    server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch(request) {
        const path = new URL(request.url).pathname.slice(1);
        const body =
          path === ""
            ? "<!doctype html><title>C pthread Runtime proof</title>"
            : assets.has(path)
              ? Bun.file(join(directory, path))
              : undefined;
        return new Response(body ?? "not found", {
          status: body === undefined ? 404 : 200,
          headers: {
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Embedder-Policy": "require-corp",
            "Cache-Control": "no-store",
            "Content-Type": path.endsWith(".js")
              ? "text/javascript"
              : path.endsWith(".wasm")
                ? "application/wasm"
                : "text/html",
          },
        });
      },
    });
    const created = object(
      await command(driver, "/session", {
        capabilities: { alwaysMatch: { browserName: "safari", platformName: "mac" } },
      }),
    );
    if (typeof created.sessionId !== "string") throw new Error("missing Safari session");
    session = created.sessionId;
    const capabilities = object(created.capabilities);
    if (
      (capabilities.browserName !== "Safari" && capabilities.browserName !== "safari") ||
      capabilities.platformName !== "macOS" ||
      capabilities["safari:useSimulator"] !== false
    )
      throw new Error("not actual desktop Safari");
    await save(join(output, "session.json"), {
      session,
      capabilities,
      manifest,
      manifestSha256: digest,
    });
    await command(driver, `/session/${session}/timeouts`, { script: 120_000 });
    const origins = new Set<number>();
    const rows = [];
    for (const mode of ["pair", "repeat", "nested"]) {
      const url = new URL(`?case=${mode}&nonce=${crypto.randomUUID()}`, server.url).href;
      await command(driver, `/session/${session}/url`, { url });
      const window = await command(driver, `/session/${session}/window`, undefined, "GET");
      const script = `const done = arguments[arguments.length - 1];
import('/runtime-page.js').then(async module => {
  const source = new Uint8Array(await (await fetch('/c-threads.wasm')).arrayBuffer());
  return module.runCThreadsRuntime(source, ${JSON.stringify(mode)});
}).then(result => done({result}), error => done({failure: String(error), stack: error?.stack}));`;
      const raw = object(
        await command(driver, `/session/${session}/execute/async`, { script, args: [] }),
      );
      const evidence = { mode, url, window, manifest, manifestSha256: digest, capabilities, raw };
      await save(join(output, `${mode}.json`), evidence);
      if ("failure" in raw) throw new Error(`C Safari ${mode} failed: ${JSON.stringify(raw)}`);
      const row = object(raw.result);
      const control = object(row.control);
      if (
        row.passed !== true ||
        row.isolated !== true ||
        row.documentURL !== url ||
        control.url !== url ||
        control.atomic !== 42 ||
        control.isolated !== true ||
        typeof control.nonce !== "string" ||
        typeof control.timeOrigin !== "number" ||
        control.timeOrigin !== row.timeOrigin ||
        origins.has(control.timeOrigin)
      )
        throw new Error(`C Safari ${mode} contract or same-document control failed`);
      origins.add(control.timeOrigin);
      rows.push(evidence);
      console.log(JSON.stringify({ engine: "safari", mode, manifestSha256: digest, report: row }));
    }
    await cleanup();
    await save(join(output, "summary.json"), {
      manifest,
      manifestSha256: digest,
      capabilities,
      rows,
      cleanup: { sessionDeleted: true, serverStopped: true },
    });
  } finally {
    clearTimeout(deadline);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await cleanup();
  }
}
if (import.meta.main) {
  const [directory, digest, driver, port, output] = process.argv.slice(2);
  if (!directory || !digest || !driver || !output || !Number.isInteger(Number(port)))
    throw new Error("usage: runner.mjs PACKET MANIFEST_SHA256 DRIVER_URL PORT NEW_OUTPUT");
  await run(resolve(directory), digest, driver, Number(port), resolve(output));
}
