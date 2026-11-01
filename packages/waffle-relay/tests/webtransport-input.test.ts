import { expect, test } from "bun:test";

for (const mode of ["keys", "callback", "browser"]) {
  test(`WebTransport ${mode} input boundary in an isolated process`, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("./webtransport-input-fixture.ts", import.meta.url).pathname,
        mode,
      ],
      { stdout: "pipe", stderr: "pipe", timeout: 5000 },
    );
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      if (mode === "browser") expect(stdout).toContain('"listeners":0');
    } finally {
      child.kill();
      await child.exited;
    }
  }, 10000);
}
