import { expect, spyOn, test } from "bun:test";
import { createRuntime, RuntimeNetworkLookupError } from "../index.js";
import { NetHelper, NetNamespace } from "../browser/net/helper.js";

function create() {
  return createRuntime({
    filesystem: {
      workerURL: new URL("../browser/fs-worker.ts", import.meta.url),
      mode: "memory",
    },
    processHost() {
      throw Error("Process activation is not part of lookup");
    },
  });
}

function noIO(): never {
  throw Error("Lookup must not perform I/O");
}

function failure(operation: () => unknown): unknown {
  try {
    return operation();
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeNetworkLookupError);
    return error;
  }
}

test("exported runtime lookup follows virtual policy before any helper or listener exists", async () => {
  const runtime = create();
  const network = await runtime.network();
  const controls = [
    spyOn(NetNamespace.prototype, "listen").mockImplementation(noIO),
    spyOn(NetNamespace.prototype, "connect").mockImplementation(noIO),
    spyOn(NetHelper.prototype, "handle").mockImplementation(noIO),
    spyOn(globalThis, "fetch").mockImplementation(noIO),
    spyOn(Bun, "listen").mockImplementation(noIO),
    spyOn(Bun, "connect").mockImplementation(noIO),
    spyOn(Bun, "spawn").mockImplementation(noIO),
    spyOn(Bun, "spawnSync").mockImplementation(noIO),
  ];
  try {
    expect(Object.keys(network)).toEqual(["createHelper", "lookup"]);
    const localhost = [{ address: "127.0.0.1", family: 4 }];
    expect(network.lookup("localhost", { family: 0, hints: 0 })).toEqual(localhost);
    expect(network.lookup("localhost")).toEqual(localhost);
    expect(network.lookup("localhost", { family: 4 })).toEqual(localhost);
    expect(network.lookup("127.0.0.1", { family: 0 })).toEqual(localhost);
    expect(network.lookup("::1", { family: 0 })).toEqual([{ address: "::1", family: 6 }]);
    expect(network.lookup("::1", { family: 6 })).toEqual([{ address: "::1", family: 6 }]);
    for (const control of controls) expect(control).not.toHaveBeenCalled();
  } finally {
    for (const control of controls) control.mockRestore();
    await runtime.dispose();
  }
});

test("lookup gives adapters fresh mutable arrays and records", async () => {
  const runtime = create();
  try {
    const network = await runtime.network();
    const first = network.lookup("localhost");
    const second = network.lookup("localhost");
    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
    expect(Object.isFrozen(first)).toBe(false);
    expect(Object.isFrozen(first[0])).toBe(false);
    first.splice(0, 1, { address: "changed", family: 6 });
    second[0]!.address = "changed too";
    expect(network.lookup("localhost")).toEqual([{ address: "127.0.0.1", family: 4 }]);
  } finally {
    await runtime.dispose();
  }
});

test("unsupported names and hints preserve getaddrinfo fields instead of claiming ENOTFOUND", async () => {
  const runtime = create();
  try {
    const network = await runtime.network();
    for (const hostname of ["example.com", "LOCALHOST", "localhost.", "0.0.0.0", "::"]) {
      expect(failure(() => network.lookup(hostname))).toMatchObject({
        name: "RuntimeNetworkLookupError",
        code: "ENOTSUP",
        hostname,
        syscall: "getaddrinfo",
      });
    }
    expect(failure(() => network.lookup("localhost", { hints: 1 }))).toMatchObject({
      code: "ENOTSUP",
      hostname: "localhost",
      syscall: "getaddrinfo",
    });
    for (const hostname of ["localhost", "127.0.0.1"]) {
      expect(failure(() => network.lookup(hostname, { family: 6 }))).toMatchObject({
        code: "ENOTFOUND",
        hostname,
        syscall: "getaddrinfo",
      });
    }
    expect(failure(() => network.lookup("::1", { family: 4 }))).toMatchObject({
      code: "ENOTFOUND",
      hostname: "::1",
      syscall: "getaddrinfo",
    });
    expect(() => network.lookup("")).toThrow(TypeError);
    expect(() => Reflect.apply(network.lookup, undefined, ["localhost", { family: 5 }])).toThrow(
      TypeError,
    );
  } finally {
    await runtime.dispose();
  }
});

test("lookup observes disposal including option getter reentry", async () => {
  const runtime = create();
  const network = await runtime.network();
  const options = {
    get family(): 0 {
      void runtime.dispose();
      return 0;
    },
  };
  try {
    expect(() => network.lookup("localhost", options)).toThrow("Runtime is disposed");
    expect(() => network.lookup("localhost")).toThrow("Runtime is disposed");
  } finally {
    await runtime.dispose();
  }
});
