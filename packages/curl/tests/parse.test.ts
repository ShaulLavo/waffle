import { expect, test } from "bun:test";
import { parseCurl } from "../src/parse.ts";
import { runCurl } from "../src/curl.ts";
import { invocation } from "./helpers.ts";

test("parses clusters, attached values, headers and method", () => {
  const request = parseCurl([
    "-fsSLi",
    "-XPUT",
    "-Hx-test: one",
    "--header=x-test: two",
    "--data=hello",
    "-oout",
    "-m.2",
    "http://127.0.0.1/",
  ]);
  expect(request).toMatchObject({
    fail: true,
    silent: true,
    showError: true,
    follow: true,
    include: true,
    method: "PUT",
    output: "out",
  });
  expect(request.headers.get("x-test")).toBe("one, two");
});

test("HEAD and POST inference, end of flags, literal data preservation", () => {
  expect(parseCurl(["-I", "--", "https://example.invalid"]).method).toBe("HEAD");
  expect(parseCurl(["-d", "a\nb", "https://example.invalid"]).data).toEqual([
    { value: "a\nb", binary: false },
  ]);
  expect(parseCurl(["-d", "", "https://example.invalid"]).method).toBe("POST");
});

test("rejects unsupported syntax before any fetch", async () => {
  for (const argv of [
    [],
    ["--insecure", "https://example.invalid"],
    ["file:///etc/passwd"],
    ["https://user:secret@example.invalid"],
    ["-m", "0", "https://example.invalid"],
    ["-H", "Host: elsewhere", "https://example.invalid"],
    ["-X", "TRACE", "https://example.invalid"],
    ["-d", "x", "-X", "GET", "https://example.invalid"],
    ["https://example.invalid", "https://other.invalid"],
    ["-o"],
    ["--follow"],
    ["--head=true"],
  ]) {
    const context = invocation(argv);
    const code = await runCurl({
      ...context.call,
      fetch: async () => {
        throw new Error("MUST NOT FETCH");
      },
    });
    expect(code).not.toBe(0);
    expect(context.errors.join("")).not.toContain("secret");
    expect(context.written).toHaveLength(0);
  }
});

test("header values are validated and browser-owned names are rejected", () => {
  for (const header of [
    "Cookie: x",
    "Sec-Test: x",
    "Proxy-Test: x",
    "Content-Length: 2",
    "Origin: x",
    "X-Test: a\nb",
    "invalid",
  ]) {
    expect(() => parseCurl(["-H", header, "https://example.invalid"])).toThrow();
  }
});

test("help obeys the same overall deadline and cancellation rules", async () => {
  const context = invocation(["--help"]);
  expect(await runCurl(context.call)).toBe(0);
  expect(context.stdout.text()).toContain("Fetch-based HTTP subset");
  expect(await runCurl({ ...context.call, timeoutMs: Infinity })).toBe(2);
  context.controller.abort();
  expect(await runCurl(context.call)).toBe(42);
});
