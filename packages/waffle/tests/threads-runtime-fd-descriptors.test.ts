import { expect, test } from "bun:test";

for (const selected of ["read", "write"]) {
  test(`real Runtime sibling lanes share the file cursor and retain a delayed ${selected} across close and reuse`, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("./threads-runtime-fd-control.ts", import.meta.url).pathname,
        selected,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const timer = setTimeout(() => child.kill(), 25000);
    try {
      const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(await child.exited, stderr).toBe(0);
      expect(JSON.parse(stdout.trim())).toMatchObject({
        selected,
        workers: 4,
        stopped: 4,
        drained: 1,
        disposed: 1,
        errors: [],
        pipe: "PRM",
        exit: { kind: "exited", code: 0, status: 0 },
        beforeRelease: { references: 1, offset: 0 },
        originalCompletion: {
          result: { kind: "ok", value: 2 },
          original: { references: 0, offset: 2 },
        },
        originalBytes: selected === "read" ? "ABCDExyHIJ" : "UVCDExyHIJ",
        replacementBytes: "12Q4567890",
      });
    } finally {
      clearTimeout(timer);
      child.kill();
      await child.exited;
    }
  }, 30000);
}
