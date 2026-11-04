import { expect, test } from "bun:test";

for (const selected of [
  "guest-constructor",
  "guest-bootstrap",
  "guest-post",
  "guest-stop",
  "control-exhaustion",
  "drain-failure",
]) {
  test(`real Runtime ${selected} preserves fault ownership across repeated disposal`, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("./threads-runtime-fault-control.ts", import.meta.url).pathname,
        selected,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const watchdog = setTimeout(() => child.kill(), 22000);
    try {
      const [output, errors, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, errors.concat("\n", output)).toBe(0);
      expect(output).toContain(`fault case passed: ${selected}`);
    } finally {
      clearTimeout(watchdog);
      child.kill();
      await child.exited;
    }
  }, 25000);
}
