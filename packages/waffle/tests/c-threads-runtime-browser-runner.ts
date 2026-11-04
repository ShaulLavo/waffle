import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readCThreadsPacket } from "./c-threads-packet.js";
import { verifiedCThreadFixture } from "../scripts/build-c-thread-fixture.js";
import {
  cThreadArtifactSha256,
  cThreadReceiptSha256,
  runCThreadsRuntime,
} from "./c-threads-runtime-browser.js";

const args = process.argv.slice(2);
const caseIndex = args.indexOf("--case");
const selected = caseIndex < 0 ? "pair" : args.splice(caseIndex, 2)[1];
if (selected !== "pair" && selected !== "repeat" && selected !== "nested")
  throw new Error("unknown C Runtime case");
const packetIndex = args.indexOf("--packet");
const packetDirectory = packetIndex < 0 ? undefined : args.splice(packetIndex, 2)[1];
const packetManifestSha256 = process.env.C_THREAD_PACKET_SHA256;
const packet =
  packetDirectory && packetManifestSha256
    ? await readCThreadsPacket(packetDirectory, packetManifestSha256)
    : undefined;
if (packetDirectory && !packet) throw new Error("set C_THREAD_PACKET_SHA256");
const directory = packetDirectory ?? process.env.C_THREAD_FIXTURE_DIR;
if (!directory) throw new Error("set C_THREAD_FIXTURE_DIR to the retained C artifact directory");
const wasm = packet
  ? new Uint8Array(readFileSync(join(directory, "c-threads.wasm")))
  : verifiedCThreadFixture(directory);
const artifact = createHash("sha256").update(wasm).digest("hex");
const receipt = createHash("sha256")
  .update(readFileSync(join(directory, "c-threads.receipt.json")))
  .digest("hex");
if (artifact !== cThreadArtifactSha256) throw new Error(`C artifact changed: ${artifact}`);
if (receipt !== cThreadReceiptSha256) throw new Error(`C receipt changed: ${receipt}`);

if (args[0] === "--embedding") {
  const { runCThreadsEmbedding } = await import("./c-threads-embedding-runner.js");
  const report = await runCThreadsEmbedding(wasm);
  console.log(
    JSON.stringify({
      engine: "bun-low-level",
      version: Bun.version,
      artifactSha256: artifact,
      receiptSha256: receipt,
      report,
    }),
  );
  if (
    report.resolution.kind !== "resolved" ||
    report.outcome?.kind !== "exited" ||
    report.outcome.code !== 0
  )
    process.exitCode = 1;
} else if (args[0] === "--bun") {
  const report = await runCThreadsRuntime(wasm, selected, true);
  console.log(
    JSON.stringify({
      engine: "bun",
      version: Bun.version,
      packet,
      packetManifestSha256,
      receiptSha256: receipt,
      report,
    }),
  );
  if (!report.passed) process.exitCode = 1;
} else {
  const scratchRoot = process.env.PROCESS_SCRATCH_ROOT;
  const port = Number(process.env.C_THREADS_RUNTIME_PORT);
  if (!scratchRoot || !Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("set PROCESS_SCRATCH_ROOT and explicit C_THREADS_RUNTIME_PORT");
  const { runIsolatedPages } = await import("./isolated-page-runner.js");
  await runIsolatedPages({
    label: "c-threads-runtime",
    scratchRoot,
    scratchPrefix: "cthread-",
    port,
    names: args.length ? args : ["chromium"],
    sources: packet
      ? {}
      : {
          "/c-positive.js": new URL("./c-threads-positive-worker.ts", import.meta.url).pathname,
          "/runtime-page.js": new URL("./c-threads-runtime-browser.ts", import.meta.url).pathname,
          "/fs-worker.js": new URL("../browser/fs-worker.ts", import.meta.url).pathname,
          "/preview1-worker.js": new URL("../browser/preview1-worker.ts", import.meta.url).pathname,
          "/thread-service.js": new URL("../thread/service-worker.ts", import.meta.url).pathname,
          "/thread-guest.js": new URL("./c-threads-runtime-guest.ts", import.meta.url).pathname,
        },
    route: (path, headers) => {
      const asset = packet?.assets.find((entry) => path === `/${entry.path}`);
      if (asset)
        return new Response(Bun.file(join(directory, asset.path)), {
          headers: {
            ...headers,
            "content-type": path.endsWith(".wasm") ? "application/wasm" : "text/javascript",
          },
        });
      if (path === "/c-threads.wasm")
        return new Response(wasm, { headers: { ...headers, "content-type": "application/wasm" } });
      return undefined;
    },
    evaluate: async (page) => {
      const report = await page.evaluate(async (mode) => {
        if (mode !== "pair" && mode !== "repeat" && mode !== "nested")
          throw new Error("unknown C Runtime mode");
        const module = (await import(
          "/runtime-page.js" as string
        )) as typeof import("./c-threads-runtime-browser.js");
        const source = new Uint8Array(await (await fetch("/c-threads.wasm")).arrayBuffer());
        return module.runCThreadsRuntime(source, mode);
      }, selected);
      console.log(
        JSON.stringify({
          browserVersion: page.context().browser()?.version(),
          receiptSha256: receipt,
          packet,
          packetManifestSha256,
          report,
        }),
      );
      if (!report.passed)
        throw new Error("retained C artifact did not pass the real Runtime contract");
      return report;
    },
  });
}
