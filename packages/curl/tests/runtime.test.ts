import { afterEach, expect, spyOn, test } from "bun:test";
import { createCurlPackage, type CurlPackageOptions } from "../src/index.ts";
import { cleanupFixtures, fixture } from "./helpers.ts";
import {
  cleanupRuntime,
  deferred,
  files,
  pipe,
  observeStdout,
  readPipe,
  runtime,
  shell,
  writePipe,
} from "./runtime-helpers.ts";

afterEach(async () => {
  await cleanupRuntime();
  await cleanupFixtures();
});

const options: CurlPackageOptions = { fetch, timeoutMs: 1500 };

async function installed(overrides: Partial<CurlPackageOptions> = {}) {
  const owner = runtime();
  const pkg = createCurlPackage({ ...options, ...overrides });
  await owner.programs.onDemand(pkg);
  return { owner, pkg, root: await shell(owner) };
}

test("curl registers on demand, shares canonical and alias preparation, and removes both", async () => {
  const server = await fixture();
  const owner = runtime();
  let requests = 0;
  const pkg = createCurlPackage({
    ...options,
    fetch: (...args) => {
      requests++;
      return fetch(...args);
    },
  });
  const load = spyOn(pkg.programs[0]!.command, "load");
  const compile = spyOn(WebAssembly, "compile");
  try {
    await owner.programs.onDemand(pkg.pick("curl"));
    await owner.programs.onDemand(pkg);
    const handle = owner.programs.get("curl")!;
    expect(owner.programs.get("/bin/curl")).toBe(handle);
    expect(handle.state).toEqual({ kind: "registered" });
    expect(load).not.toHaveBeenCalled();
    const root = await shell(owner);
    const attempts = ["/usr/bin/curl", "/bin/curl"].map(async (path) =>
      (await root.spawn(path, [`${server.url}/ok`])).collect(),
    );
    await owner.programs.preload("curl");
    expect(await Promise.all(attempts)).toMatchObject([
      { kind: "exited", code: 0 },
      { kind: "exited", code: 0 },
    ]);
    expect(Buffer.concat(root.stdout).toString()).toBe("hello\nhello\n");
    expect(load).toHaveBeenCalledTimes(1);
    expect(requests).toBe(2);
    expect(handle.state).toEqual({ kind: "loaded" });
    expect(compile).not.toHaveBeenCalled();
    await handle.remove();
    expect(await owner.filesystem.lookup("/usr/bin/curl")).toBeUndefined();
    expect(await owner.filesystem.lookup("/bin/curl")).toBeUndefined();
    expect(await (await root.spawn("/bin/curl", [`${server.url}/ok`])).collect()).toMatchObject({
      kind: "start-failed",
    });
    await owner.programs.onDemand(createCurlPackage(options));
    await expect(handle.preload()).rejects.toThrow();
    expect(await (await root.spawn("/usr/bin/curl", [`${server.url}/ok`])).collect()).toMatchObject(
      { kind: "exited", code: 0 },
    );
  } finally {
    load.mockRestore();
    compile.mockRestore();
  }
});

test("removal during actual curl loading closes both paths and joins the pending loader", async () => {
  const { owner, pkg, root } = await installed();
  const entered = deferred();
  const release = deferred();
  const original = pkg.programs[0]!.command.load;
  const load = spyOn(pkg.programs[0]!.command, "load").mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    return original();
  });
  try {
    const starting = root.spawn("/bin/curl", ["--help"]);
    await entered.promise;
    const handle = owner.programs.get("curl")!;
    expect(handle.state).toEqual({ kind: "preparing" });
    const removing = handle.remove();
    let removed = false;
    void removing.then(() => {
      removed = true;
    });
    expect(handle.state).toEqual({ kind: "removed" });
    await expect(handle.preload()).rejects.toThrow();
    expect(await (await root.spawn("/usr/bin/curl", ["--help"])).collect()).toMatchObject({
      kind: "start-failed",
    });
    expect(removed).toBe(false);
    release.resolve();
    expect(await (await starting).collect()).toMatchObject({ kind: "start-failed" });
    await removing;
    expect(root.stdout).toHaveLength(0);
  } finally {
    load.mockRestore();
  }
});

test("real stdin and stdout pipes transfer a MiB under backpressure without an interpreter", async () => {
  const server = await fixture();
  const { owner, root, pkg } = await installed();
  const input = pipe(root.root);
  const output = pipe(root.root);
  root.descriptors.openAt(0, input.reader, 2n, 0n);
  root.descriptors.close(1);
  root.descriptors.openAt(1, output.writer, 64n, 0n);
  const writingOutput = deferred();
  const original = pkg.programs[0]!.command.load;
  const load = spyOn(pkg.programs[0]!.command, "load").mockImplementation(async () => {
    const run = await original();
    return (context) => run(observeStdout(context, writingOutput.resolve));
  });
  try {
    const child = await root.spawn(
      "/bin/curl",
      ["--data-binary", "@-", `${server.url}/echo`],
      "/",
      [
        { parent: 0, child: 0 },
        { parent: 1, child: 1 },
        { parent: 2, child: 2 },
      ],
    );
    root.descriptors.close(0);
    root.descriptors.close(1);
    const bytes = Uint8Array.from({ length: 1024 * 1024 + 17 }, (_, index) => index % 251);
    await writePipe(input.writer, bytes);
    await writingOutput.promise;
    let exited = false;
    void child.exit.then(() => {
      exited = true;
    });
    let removed = false;
    const removing = owner.programs
      .get("curl")!
      .remove()
      .then(() => {
        removed = true;
      });
    await Promise.resolve();
    expect(exited).toBe(false);
    expect(removed).toBe(false);
    const received = await readPipe(output.reader);
    expect(JSON.parse(received.toString()).body).toBe(Buffer.from(bytes).toString("base64"));
    expect(await child.collect()).toMatchObject({ kind: "exited", code: 0 });
    await removing;
  } finally {
    load.mockRestore();
  }
});

test("only explicitly granted file callbacks receive the real cwd and unchanged path", async () => {
  const server = await fixture();
  const owner = runtime();
  const grant = files(owner);
  await owner.filesystem.mkdirp("/work/input");
  await owner.filesystem.writeFile("/work/input/payload", new Uint8Array([65, 0, 10, 255]));
  await owner.programs.onDemand(createCurlPackage({ ...options, files: grant.capabilities }));
  const root = await shell(owner);
  const child = await root.spawn(
    "/bin/curl",
    ["--data-binary", "@input/payload", "-o", "./reply", `${server.url}/echo`],
    "/work",
  );
  expect(await child.collect()).toMatchObject({ kind: "exited", code: 0 });
  expect(grant.paths).toEqual([
    { path: "input/payload", cwd: "/work" },
    { path: "./reply", cwd: "/work" },
  ]);
  const reply = await owner.filesystem.readFile("/work/reply");
  expect(JSON.parse(new TextDecoder().decode(reply)).body).toBe(
    Buffer.from([65, 0, 10, 255]).toString("base64"),
  );
  expect(grant.events).toEqual(["write", "close"]);
});

test("ungranted and invalid output paths stay denied and diagnostics use real stderr", async () => {
  const server = await fixture();
  const { owner, root } = await installed();
  expect(
    await (await root.spawn("/bin/curl", ["-o", "out", `${server.url}/ok`])).collect(),
  ).toMatchObject({ kind: "exited", code: 23 });
  expect(await owner.filesystem.lookup("/out")).toBeUndefined();
  expect(Buffer.concat(root.stderr).toString()).toContain("curl: (23)");
  expect(
    await (
      await root.spawn("/bin/curl", ["--data-binary", "@out", `${server.url}/echo`])
    ).collect(),
  ).toMatchObject({ kind: "exited", code: 26 });
  const requests = server.requests.length;
  for (const flags of [["-o", ""], ["--output="], ["-o", "bad\0name"]]) {
    expect(
      await (await root.spawn("/bin/curl", flags.concat(`${server.url}/ok`))).collect(),
    ).toMatchObject({ kind: "exited", code: 2 });
  }
  expect(server.requests).toHaveLength(requests);
});

test.each([15, 9])(
  "signal %s aborts stalled HTTP and releases the real command removal hold",
  async (signal) => {
    const server = await fixture();
    const entered = deferred();
    const stopped = deferred();
    const { owner, root } = await installed({
      fetch: async (...args) => {
        entered.resolve();
        try {
          return await fetch(...args);
        } finally {
          stopped.resolve();
        }
      },
    });
    const child = await root.spawn("/bin/curl", [`${server.url}/stall`]);
    await entered.promise;
    await root.service.kill(child.pid, signal);
    expect(await child.collect()).toMatchObject({ kind: "signaled", code: signal });
    await owner.programs.get("curl")!.remove();
    await stopped.promise;
  },
);

test("runtime disposal waits for partial-file abort cleanup, not merely a signaled exit", async () => {
  const server = await fixture();
  const owner = runtime();
  const grant = files(owner);
  const written = deferred();
  const aborting = deferred();
  const release = deferred();
  await owner.programs.onDemand(
    createCurlPackage({
      ...options,
      files: {
        read: grant.capabilities.read,
        async write(request) {
          const output = await grant.capabilities.write(request);
          return {
            async write(bytes, signal) {
              await output.write(bytes, signal);
              written.resolve();
            },
            close: output.close,
            async abort(reason) {
              aborting.resolve();
              await release.promise;
              await output.abort(reason);
            },
          };
        },
      },
    }),
  );
  const root = await shell(owner);
  const child = await root.spawn("/bin/curl", ["-o", "/partial", `${server.url}/drip`]);
  await written.promise;
  expect(new TextDecoder().decode(await owner.filesystem.readFile("/partial"))).toBe("prefix\n");
  let disposed = false;
  const disposal = owner.dispose().then(() => {
    disposed = true;
  });
  await aborting.promise;
  expect(await child.exit).toMatchObject({ kind: "signaled", code: 9 });
  expect(disposed).toBe(false);
  release.resolve();
  await disposal;
  expect(grant.events).toEqual(["write", "abort"]);
});

test("a -m deadline ends stalled runtime stdin without leaving physical I/O debt", async () => {
  const server = await fixture();
  const { owner, root } = await installed();
  const input = pipe(root.root);
  root.descriptors.openAt(0, input.reader, 2n, 0n);
  const child = await root.spawn(
    "/bin/curl",
    ["-m", "0.05", "--data-binary", "@-", `${server.url}/echo`],
    "/",
    [
      { parent: 0, child: 0 },
      { parent: 1, child: 1 },
      { parent: 2, child: 2 },
    ],
  );
  root.descriptors.close(0);
  expect(await child.collect()).toMatchObject({ kind: "exited", code: 28 });
  await owner.programs.get("curl")!.remove();
  expect(server.requests).toHaveLength(0);
});

test("a -m deadline fences a backpressured runtime stdout write", async () => {
  const server = await fixture();
  const { owner, root } = await installed();
  const output = pipe(root.root);
  root.descriptors.close(1);
  root.descriptors.openAt(1, output.writer, 64n, 0n);
  const child = await root.spawn("/bin/curl", [
    "-m",
    "0.1",
    "-d",
    "x".repeat(20000),
    `${server.url}/echo`,
  ]);
  root.descriptors.close(1);
  expect(await child.collect()).toMatchObject({ kind: "exited", code: 28 });
  await owner.programs.get("curl")!.remove();
});

test("stalled real stderr diagnostics are bounded and their I/O is fenced at exit", async () => {
  const server = await fixture();
  const fetching = deferred();
  const respond = deferred();
  const { owner, root } = await installed({
    timeoutMs: 100,
    fetch: async (...args) => {
      fetching.resolve();
      await respond.promise;
      return fetch(...args);
    },
  });
  const errors = pipe(root.root);
  root.descriptors.close(2);
  root.descriptors.openAt(2, errors.writer, 64n, 0n);
  const child = await root.spawn("/bin/curl", ["-f", `${server.url}/missing`]);
  root.descriptors.close(2);
  await fetching.promise;
  const lane = errors.writerFor(child.pid);
  expect(lane.tryWrite([new Uint8Array(65536)])).toBeGreaterThan(0);
  expect(lane.tryWrite([new Uint8Array(1)])).toBe(-6);
  respond.resolve();
  expect(await child.collect()).toMatchObject({ kind: "exited", code: 22 });
  await owner.programs.get("curl")!.remove();
});
