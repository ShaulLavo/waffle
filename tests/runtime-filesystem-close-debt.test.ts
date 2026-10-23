import { expect, test } from "bun:test";
import { runtimeFilesystemCloseDebtPath } from "./fixtures/runtime-filesystem-close-debt.js";

test.each(["error", "undefined", "null", "false", "zero", "empty", "object", "success"])(
  "Runtime keeps original filesystem disposal ownership for %s",
  async (mode) => {
    const page = Bun.spawn([process.execPath, runtimeFilesystemCloseDebtPath, mode], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 3000,
      killSignal: "SIGKILL",
    });
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        page.exited,
        new Response(page.stdout).text(),
        new Response(page.stderr).text(),
      ]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      const success = mode === "success";
      expect(JSON.parse(stdout)).toEqual({
        rejected: !success,
        originalReason: !success,
        sameRejection: !success,
        samePromise: true,
        pendingGuard: true,
        sameToken: !success,
        blocked: !success,
        closes: 1,
        terminations: Number(success),
        success,
      });
    } finally {
      page.kill();
      await page.exited;
    }
  },
);
