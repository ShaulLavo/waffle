import { afterEach, expect, test } from "bun:test";
import { runCurl } from "../src/curl.ts";
import { createCurlCommand, curlPaths } from "../src/index.ts";
import { capture, cleanupFixtures, fixture, invocation } from "./helpers.ts";

// Hooks belong to this test file, not the cached helper module.
afterEach(cleanupFixtures);

test("GET streams to borrowed stdout without closing it", async () => {
  const server = await fixture();
  const context = invocation([`${server.url}/ok`]);
  expect(await runCurl(context.call)).toBe(0);
  expect(context.stdout.text()).toBe("hello\n");
  expect(context.stdout.state()).toEqual({ closed: 0, aborted: 0 });
  expect(context.errors).toHaveLength(0);
});

test("HEAD, include, manual redirect and automatic redirect", async () => {
  const server = await fixture();
  for (const flags of [["-I"], ["-i"], [], ["-L"]]) {
    const target = flags.length && flags[0] !== "-L" ? "/ok" : "/redirect";
    const context = invocation(flags.concat(`${server.url}${target}`));
    expect(await runCurl(context.call)).toBe(0);
    if (flags[0] === "-I")
      expect(context.stdout.text()).toMatch(/^HTTP 200 OK\r\n[\s\S]*\r\n\r\n$/);
    if (flags[0] === "-i") expect(context.stdout.text()).toEndWith("\r\n\r\nhello\n");
    if (flags[0] === "-L") expect(context.stdout.text()).toBe("hello\n");
    if (!flags.length) expect(context.stdout.text()).toBe("redirect");
  }
});

test("HTTP --fail, silent and show-error semantics preserve existing files", async () => {
  const server = await fixture();
  for (const flags of [[], ["-f"], ["-fs"], ["-fsS"]]) {
    const context = invocation(flags.concat(["-o", "out", `${server.url}/missing`]));
    const failed = flags.length > 0;
    expect(await runCurl(context.call)).toBe(failed ? 22 : 0);
    expect(context.written.length).toBe(failed ? 0 : 1);
    expect(context.file.text()).toBe(failed ? "" : "missing\n");
    expect(context.errors.length).toBe(failed && flags[0] !== "-fs" ? 1 : 0);
  }
});

test("data literals, binary stdin and guest files match the request bytes", async () => {
  const server = await fixture();
  const bytes = new Uint8Array([65, 0, 10, 13, 66, 255]);
  for (const data of [
    ["--data-binary", "@-"],
    ["--data-binary", "@guest"],
    ["--data", "@guest"],
    ["--data", "a\nb", "--data", "c"],
  ]) {
    const context = invocation(
      ["-X", "PUT", "-H", "X-Test: synthetic"].concat(data, [`${server.url}/echo`]),
      bytes,
    );
    expect(await runCurl(context.call)).toBe(0);
    const expected =
      data[1] === "a\nb"
        ? Buffer.from("a\nb&c")
        : data[0] === "--data"
          ? Buffer.from([65, 66, 255])
          : Buffer.from(bytes);
    expect(JSON.parse(context.stdout.text())).toEqual({
      method: "PUT",
      body: expected.toString("base64"),
      header: "synthetic",
      type: "application/x-www-form-urlencoded",
    });
    expect(context.reads()).toBe(data[1] === "@guest" ? 1 : 0);
  }
});

test("replayable upload follows a 307 through Fetch", async () => {
  const server = await fixture();
  const context = invocation(
    ["-L", "--data-binary", "@-", `${server.url}/post-redirect`],
    new TextEncoder().encode("upload"),
  );
  expect(await runCurl(context.call)).toBe(0);
  expect(JSON.parse(context.stdout.text())).toMatchObject({
    method: "POST",
    body: Buffer.from("upload").toString("base64"),
  });
});

test("-o owns file close but -o - borrows stdout", async () => {
  const server = await fixture();
  const file = invocation(["-o", "guest/out", `${server.url}/ok`]);
  expect(await runCurl(file.call)).toBe(0);
  expect(file.file.state()).toEqual({ closed: 1, aborted: 0 });
  expect(file.stdout.text()).toBe("");
  const stdout = invocation(["-o", "-", `${server.url}/ok`]);
  expect(await runCurl(stdout.call)).toBe(0);
  expect(stdout.stdout.text()).toBe("hello\n");
  expect(stdout.written).toHaveLength(0);
});

test("overall deadline covers missing headers and a partial body", async () => {
  const server = await fixture();
  for (const path of ["/stall", "/drip"]) {
    const context = invocation(["-m", "0.05", "-o", "partial", `${server.url}${path}`]);
    expect(await runCurl(context.call)).toBe(28);
    if (path === "/drip") expect(context.file.state()).toEqual({ closed: 0, aborted: 1 });
    expect(context.errors.join("")).toContain("deadline");
  }
});

test("caller cancellation and pre-aborted calls never turn into success", async () => {
  const server = await fixture();
  const context = invocation([`${server.url}/drip`]);
  const output = capture();
  expect(
    await runCurl({
      ...context.call,
      stdout: {
        ...output.output,
        async write(bytes, signal) {
          await output.output.write(bytes, signal);
          context.controller.abort();
        },
      },
    }),
  ).toBe(42);
  const before = server.requests.length;
  expect(await runCurl(context.call)).toBe(42);
  expect(server.requests.length).toBe(before);
  expect(output.text()).toBe("prefix\n");
});

test("partial response failure aborts file and returns 18", async () => {
  const server = await fixture();
  const context = invocation(["-o", "partial", `${server.url}/partial`]);
  expect(await runCurl(context.call)).toBe(18);
  expect(context.file.text()).toBe("prefix\n");
  expect(context.file.state()).toEqual({ closed: 0, aborted: 1 });
});

test("output failure aborts file and cancels the response", async () => {
  const server = await fixture();
  const context = invocation(["-o", "broken", `${server.url}/drip`]);
  const output = {
    ...context.file.output,
    async write() {
      throw new Error("broken pipe");
    },
  };
  expect(
    await runCurl({
      ...context.call,
      files: {
        ...context.call.files,
        async write() {
          return output;
        },
      },
    }),
  ).toBe(23);
  expect(context.file.state()).toEqual({ closed: 0, aborted: 1 });
});

test("input failure and stalled input deadline cancel their readers", async () => {
  const context = invocation(["--data-binary", "@-", "http://127.0.0.1:46271/never"]);
  let cancelled = false;
  const stdin = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  expect(
    await runCurl({
      ...context.call,
      stdin,
      timeoutMs: 30,
      fetch: async () => {
        throw new Error("MUST NOT FETCH");
      },
    }),
  ).toBe(28);
  expect(cancelled).toBe(true);
  expect(stdin.locked).toBe(false);
  const broken = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("input failed"));
    },
  });
  expect(await runCurl({ ...context.call, stdin: broken })).toBe(26);
  expect(broken.locked).toBe(false);
});

test("package-domain disposal shares aliases, stops active I/O, and rejects new calls", async () => {
  const server = await fixture();
  const command = createCurlCommand();
  const context = invocation([`${server.url}/drip`]);
  const call = command.run({
    ...context.call,
    stdout: {
      ...context.stdout.output,
      async write(bytes, signal) {
        await context.stdout.output.write(bytes, signal);
        void command.dispose();
      },
    },
  });
  expect(command.paths).toBe(curlPaths);
  expect(command.paths).toEqual(["/usr/bin/curl", "/bin/curl"]);
  expect(await call).toBe(42);
  const disposal = command.dispose();
  expect(command.dispose()).toBe(disposal);
  await disposal;
  await expect(command.run(context.call)).rejects.toThrow("disposed");
  expect(context.stdout.text()).toBe("prefix\n");
});

test("Fetch receives omit credentials and opaque redirects fail honestly", async () => {
  const context = invocation(["http://127.0.0.1:46271/never"]);
  const code = await runCurl({
    ...context.call,
    fetch: async (_url, options) => {
      expect(options?.credentials).toBe("omit");
      expect(options?.redirect).toBe("manual");
      return Response.error();
    },
  });
  // Response.error is an opaque network error, not an HTTP success.
  expect(code).toBe(7);
});

test("deadline waits for cooperative output cleanup and prevents later writes", async () => {
  const server = await fixture();
  const context = invocation(["-o", "slow", `${server.url}/ok`]);
  const events: string[] = [];
  const output = {
    async write(_bytes: Uint8Array, signal: AbortSignal) {
      events.push("write");
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            events.push("write-stopped");
            reject(signal.reason);
          },
          { once: true },
        ),
      );
    },
    async close() {
      events.push("close");
    },
    async abort() {
      events.push("abort-finished");
    },
  };
  expect(
    await runCurl({
      ...context.call,
      timeoutMs: 30,
      files: {
        ...context.call.files,
        async write() {
          return output;
        },
      },
    }),
  ).toBe(28);
  expect(events).toEqual(["write", "write-stopped", "abort-finished"]);
});

test("output open, close and input file failures have explicit exits", async () => {
  const server = await fixture();
  const context = invocation(["-o", "out", `${server.url}/ok`]);
  expect(
    await runCurl({
      ...context.call,
      files: {
        ...context.call.files,
        async write() {
          throw new Error("permission denied");
        },
      },
    }),
  ).toBe(23);
  const output = {
    ...context.file.output,
    async close() {
      throw new Error("flush failed");
    },
  };
  expect(
    await runCurl({
      ...context.call,
      files: {
        ...context.call.files,
        async write() {
          return output;
        },
      },
    }),
  ).toBe(23);
  expect(context.file.state().aborted).toBe(1);
  const input = invocation(["--data", "@missing", `${server.url}/echo`]);
  expect(
    await runCurl({
      ...input.call,
      files: {
        ...input.call.files,
        async read() {
          throw new Error("missing");
        },
      },
    }),
  ).toBe(26);
});

test("cancellation while waiting for response bytes does not report EOF success", async () => {
  const server = await fixture();
  const context = invocation([`${server.url}/drip`]);
  let firstWrite: (() => void) | undefined;
  const first = new Promise<void>((resolve) => {
    firstWrite = resolve;
  });
  const running = runCurl({
    ...context.call,
    stdout: {
      ...context.stdout.output,
      async write(bytes, signal) {
        await context.stdout.output.write(bytes, signal);
        firstWrite?.();
      },
    },
  });
  await first;
  context.controller.abort();
  expect(await running).toBe(42);
});

test("cancellation awaits the original pending stream cleanup, not a second cancel", async () => {
  for (const upload of [false, true]) {
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cancelling = new Promise<void>((resolve) => {
      started = resolve;
    });
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        started?.();
        return cleanup;
      },
    });
    const context = invocation(
      (upload ? ["--data-binary", "@-"] : []).concat("https://fixture.invalid/"),
    );
    const running = runCurl({
      ...context.call,
      timeoutMs: 20,
      stdin: stream,
      fetch: async () => new Response(stream),
    });
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    try {
      await cancelling;
      await Promise.resolve();
      expect(settled).toBe(false);
    } finally {
      release?.();
    }
    expect(await running).toBe(28);
    expect(stream.locked).toBe(false);
  }
});
