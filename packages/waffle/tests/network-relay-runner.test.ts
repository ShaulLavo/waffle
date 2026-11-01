import { expect, test } from "bun:test";
import { requireCertificateRejection, type RelayProbe } from "./network-relay-contract.js";

function probe(failures: string[]): RelayProbe {
  return { constructed: 1, ready: 0, streams: 0, fragments: 0, closed: 1, failures };
}

test("a pending certificate probe cannot masquerade as native rejection", () => {
  expect(() => requireCertificateRejection(probe([]))).toThrow();
});

test("an unrelated stream failure cannot masquerade as native certificate rejection", () => {
  const wrongPhase = probe([]);
  wrongPhase.ready = 1;
  wrongPhase.streams = 1;
  expect(() => requireCertificateRejection(wrongPhase)).toThrow();
});

test("one failed readiness observation proves the bad-certificate case", () => {
  expect(() => requireCertificateRejection(probe(["native readiness rejected"]))).not.toThrow();
});

for (const resource of ["browser", "fixture"])
  test(`SIGTERM reports rejected ${resource} cleanup before exiting`, async () => {
    const entry = new URL("./isolated-page-runner.ts", import.meta.url).href;
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
        import { exitAfterBrowserCleanup } from ${JSON.stringify(entry)};
        process.once("SIGTERM", () => {
          void exitAfterBrowserCleanup(${JSON.stringify(resource)}, async () => {
            throw new AggregateError([new Error("owned ${resource} close failed")], "cleanup failed");
          });
        });
        setInterval(() => {}, 1000);
        console.log("ready");
      `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      const reader = child.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n");
      reader.releaseLock();
      child.kill("SIGTERM");
      const [code, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(code).toBe(1);
      expect(JSON.parse(errors)).toEqual({
        cleanup: resource,
        failed: true,
        error: "AggregateError: cleanup failed",
        errors: [`Error: owned ${resource} close failed`],
      });
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  });
