import { expect, test } from "bun:test";
import { PreviewRouter } from "../browser/preview";
import { nativePreviewFixture, startPreviewReferenceHost } from "./preview-host-reference";

test("reference host routes initial requests, queries, POST bodies and assets through the wire relay", async () => {
  const app = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      return Response.json({
        url: request.url,
        method: request.method,
        body: await request.text(),
        header: request.headers.get("x-app"),
      });
    },
  });
  const native = nativePreviewFixture(app.port!);
  const origins = new Map<number, string>();
  const router = new PreviewRouter({
    mode: "root",
    originForPort: (port) => origins.get(port) ?? "",
  });
  router.register(3137, native.server);
  const host = await startPreviewReferenceHost({
    router,
    port: 3137,
    allocated: (origin) => origins.set(3137, origin),
  });
  try {
    const target = router.url(3137, "/nested?value=a%2Bb");
    const response = await fetch(target, {
      method: "POST",
      headers: { "x-app": "yes" },
      body: "input",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      url: target,
      method: "POST",
      body: "input",
      header: "yes",
    });
    const asset = router.url(3137, "/assets/client.js?revision=1");
    expect(await (await fetch(asset)).json()).toMatchObject({ url: asset });
  } finally {
    host.close();
    await native.close();
    app.stop(true);
  }
});
