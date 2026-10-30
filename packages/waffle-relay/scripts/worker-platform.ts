import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  Miniflare,
  Response as PlatformResponse,
} from "../../../site/node_modules/miniflare/dist/src/index.js";

let calls = 0;
const mf = new Miniflare({
  cf: false,
  host: "127.0.0.1",
  port: 0,
  resourceTmpPath: process.argv[3],
  telemetry: { enabled: false },
  workers: [
    {
      config: {
        name: "owned-relay-fixture",
        compatibilityDate: "2026-10-13",
        manifest: {
          mainModule: "worker.js",
          modules: {
            "worker.js": { type: "esm", contents: readFileSync(process.argv[2]!, "utf8") },
          },
        },
      },
      dev: {
        unsafeRegisterWorker: false,
        outboundService: {
          type: "fetcher",
          async handler(request) {
            calls++;
            assert.equal(new URL(request.url).origin, "https://owned-target.example.test");
            return new PlatformResponse("actual workerd fixture", {
              status: 203,
              headers: { "x-safe": "workerd" },
            });
          },
        },
      },
    },
  ],
});

let disposal: Promise<void> | undefined;
const dispose = () => (disposal ??= mf.dispose());
process.once("SIGTERM", () => {
  void dispose().finally(() => process.exit(143));
});
process.once("SIGINT", () => {
  void dispose().finally(() => process.exit(130));
});

async function dispatch(credential: string, url = "https://owned-target.example.test/path") {
  return mf.dispatchFetch("https://relay.example.test/v1/fetch", {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      origin: "https://owned-page.example.test",
      "x-waffle-relay-meta": encodeURIComponent(
        JSON.stringify({ version: 1, method: "GET", url, headers: [] }),
      ),
    },
  });
}
try {
  const denied = await dispatch("wrong");
  assert.equal(denied.status, 401);
  assert.equal(calls, 0);
  const forbidden = await dispatch(
    "owned-worker-fixture-token-only",
    "https://other.example.test/",
  );
  assert.equal(forbidden.status, 400);
  assert.equal(calls, 0);
  const allowed = await dispatch("owned-worker-fixture-token-only");
  assert.equal(
    allowed.status,
    200,
    allowed.headers.get("x-waffle-relay-meta") ?? "missing metadata",
  );
  const raw = allowed.headers.get("x-waffle-relay-meta");
  assert.ok(raw);
  const meta = JSON.parse(decodeURIComponent(raw));
  assert.equal(meta.status, 203);
  assert.equal(meta.url, "https://owned-target.example.test/path");
  assert.equal(await allowed.text(), "actual workerd fixture");
  assert.equal(calls, 1);
  console.log(
    JSON.stringify({
      runtime: "workerd",
      authDenial: true,
      fixedOriginDenial: true,
      targetStatus: 203,
      streamedBody: true,
    }),
  );
} finally {
  await dispose();
}
