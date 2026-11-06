import { tmpdir } from "node:os";
import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createFrameworkHost, type FrameworkOptions } from "waffle/testing/page-runner/framework";
const options = (resultPath: string): FrameworkOptions => ({
  suite: "framework-unit",
  native: { udid: "not-launched" },
  expected: [
    {
      file: "original.ts",
      fullName: "required",
      sourceKey: "original:1",
      timeoutMs: 15000,
      retries: 0,
    },
  ],
  scope: { kind: "root-selection", command: "test:browser", files: ["original.ts"] },
  resultPath,
});
async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(
    join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "waffle-framework-unit-"),
  );
  const prior = process.env.STORAGE_SCRATCH_ROOT;
  process.env.STORAGE_SCRATCH_ROOT = root;
  try {
    await run(root);
  } finally {
    if (prior === undefined) delete process.env.STORAGE_SCRATCH_ROOT;
    else process.env.STORAGE_SCRATCH_ROOT = prior;
    await rm(root, { recursive: true, force: true });
  }
}
test("framework options and reserved mounts reject before a native session can exist", () => {
  expect(() =>
    createFrameworkHost({ ...options("/result.json"), resultPath: "relative" }),
  ).toThrow();
  const host = createFrameworkHost(options("/unused.json"));
  let mounted = 0;
  expect(() =>
    host.mount({
      stack: [{ route: "/report", handle: () => {} }],
      use() {
        mounted++;
      },
    }),
  ).toThrow("conflicts");
  const stack = {
    stack: [],
    use() {
      mounted++;
    },
  };
  host.mount(stack);
  expect(() => host.mount(stack)).toThrow("conflicts");
  expect(() => createFrameworkHost(options("/unused-other.json")).mount(stack)).toThrow(
    "conflicts",
  );
  expect(mounted).toBe(1);
});
test("an already expired creation clock calls no framework callback and allocates no scratch", () =>
  fixture(async (root) => {
    const host = createFrameworkHost(options(join(root, "result.json")));
    const now = performance.now();
    const clock = spyOn(performance, "now").mockReturnValue(now + 900001);
    let calls = 0;
    try {
      const result = await host.run(async () => {
        calls++;
        return { status: "passed" };
      });
      expect(result.exit).toBe(2);
      expect(calls).toBe(0);
      expect(result.cleanup.session.status).toBe("not-created");
      expect(await readdir(root)).toEqual(["result.json"]);
    } finally {
      clock.mockRestore();
    }
  }));
async function abortControl(root: string): Promise<void> {
  const host = createFrameworkHost(options(join(root, "result.json")));
  const started = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let closes = 0;
  const running = host.run(async (registerClose) => {
    registerClose(async () => {
      closes++;
      void host.abort("synchronous close reentry");
      release.resolve();
    });
    started.resolve();
    await release.promise;
    return { status: "interrupted", errors: ["expected abort"] };
  });
  await started.promise;
  const result = await host.abort("first abort");
  expect(await running).toBe(result);
  expect(closes).toBe(1);
  expect(result.cleanup.callbacks.status).toBe("confirmed");
  expect(result.cleanup.context.status).toBe("confirmed");
  expect(result.framework?.status).toBe("interrupted");
  expect(result.cleanup.scratch.status).toBe("confirmed");
}
test("abort closes the actual context before joining its callback exactly once", () =>
  fixture(abortControl));
async function unjoinedControl(root: string): Promise<void> {
  const host = createFrameworkHost(options(join(root, "result.json")));
  const started = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    settled = Promise.withResolvers<void>();
  const running = host.run(async (registerClose) => {
    registerClose(async () => {});
    started.resolve();
    await release.promise;
    settled.resolve();
    return { status: "interrupted", errors: ["late settlement"] };
  });
  await started.promise;
  try {
    const result = await host.abort("ignored abort");
    expect(result.exit).toBe(2);
    expect(result.cleanup.callbacks.status).toBe("unconfirmed");
    expect(result.cleanup.scratch.status).toBe("unconfirmed");
    expect((await readdir(root)).some((name) => name.startsWith("waffle-framework-"))).toBe(true);
    const persisted = JSON.parse(await readFile(join(root, "result.json"), "utf8"));
    expect(persisted.cleanup.scratch.status).toBe("unconfirmed");
    expect(await running).toBe(result);
  } finally {
    release.resolve();
    await settled.promise;
  }
}
test(
  "an unjoined callback retains owned scratch without a native session",
  () => fixture(unjoinedControl),
  18000,
);
