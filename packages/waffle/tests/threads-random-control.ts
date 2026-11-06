import { guestModule, i32, call, store } from "./threads-guest-module.ts";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export async function randomFixture(shared: boolean) {
  const { guestImports } = await import("../thread/guest-imports.ts");
  const { ThreadLane, THREAD_LANE_BYTES } = await import("../thread/lane.ts");
  const { GuestTerminal } = await import("../thread/entry.ts");
  const { outcomeWord } = await import("../proc/outcome.ts");
  const module = await WebAssembly.compile(
    guestModule({
      imports: [{ name: "random_get", params: [0x7f, 0x7f] }],
      initial: store(0, i32(17).concat(i32(131073), call(0))),
    }),
  );
  const memory = new WebAssembly.Memory({ initial: 3, maximum: 512, shared });
  const channel = new MessageChannel();
  let retired = false;
  const lane = new ThreadLane(
    { port: channel.port1, reply: new SharedArrayBuffer(THREAD_LANE_BYTES) },
    () => check(!retired, "retired lane"),
  );
  const terminal = new GuestTerminal({
    thread: { directory: "random", pid: 1, tid: 1 },
    outcome: outcomeWord(),
    signal: new Int32Array(new SharedArrayBuffer(4)),
    report() {},
  });
  const imports = guestImports(module, {
    memory,
    lane,
    terminal,
    args: [],
    env: {},
    interrupt: {},
  });
  const random = imports.wasi_snapshot_preview1?.random_get;
  check(typeof random === "function", "random_get import missing");
  return {
    memory,
    module,
    imports,
    invoke: (pointer: number, length: number): unknown =>
      Reflect.apply(random, undefined, [pointer, length]),
    retire() {
      retired = true;
    },
    close() {
      channel.port1.close();
      channel.port2.close();
    },
  };
}

async function exerciseMemory(
  shared: boolean,
  calls: number[],
  generated: Uint8Array[],
  setFailure: (fail: boolean) => void,
) {
  const fixture = await randomFixture(shared);
  const { memory, invoke } = fixture;
  try {
    const bytes = new Uint8Array(memory.buffer);
    const before = calls.length;
    bytes.fill(77);
    check(invoke(17, 131073) === 0, "large random request failed");
    check(calls.slice(before).join(",") === "65536,65536,1", "Web Crypto quota chunking");
    check(
      bytes.slice(0, 17).every((byte) => byte === 77),
      "prefix overwritten",
    );
    check(
      bytes.slice(131090).every((byte) => byte === 77),
      "suffix overwritten",
    );
    const expected = new Uint8Array(131073);
    expected.set(generated[before]!, 0);
    expected.set(generated[before + 1]!, 65536);
    expected.set(generated[before + 2]!, 131072);
    check(
      expected.some((byte) => byte !== 77),
      "native source did not generate bytes",
    );
    check(
      expected.every((byte, index) => bytes[17 + index] === byte),
      "random bytes not copied exactly",
    );
    const used = calls.length;
    check(invoke(bytes.length, 0) === 0, "empty boundary request failed");
    check(calls.length === used, "empty request used randomness");
    bytes.fill(77);
    check(invoke(bytes.length - 65536, 65537) === 21, "invalid full span accepted");
    check(invoke(-1, 1) === 21, "signed wasm32 pointer accepted");
    check(invoke(bytes.length + 1, 0) === 21, "past-end empty span accepted");
    check(
      calls.length === used && bytes.every((byte) => byte === 77),
      "fault consumed entropy or wrote bytes",
    );
    setFailure(true);
    let failure: unknown;
    try {
      invoke(17, 64);
    } catch (error) {
      failure = error;
    }
    setFailure(false);
    check(
      failure instanceof Error && failure.message === "injected random source failure",
      "random failure hidden",
    );
    check(
      bytes.every((byte) => byte === 77),
      "failed random chunk wrote to guest",
    );
    memory.grow(1);
    check(invoke(3 * 65536 + 17, 64) === 0, "grown memory unavailable");
    const grown = new Uint8Array(memory.buffer, 3 * 65536 + 17, 64);
    check(
      grown.every((byte, index) => byte === generated[calls.length - 1]![index]),
      "grown memory writeback",
    );
    fixture.retire();
    const retiredCalls = calls.length;
    try {
      invoke(17, 64);
    } catch (error) {
      failure = error;
    }
    check(failure instanceof Error && failure.message === "retired lane", "retired lane accepted");
    check(calls.length === retiredCalls, "retired lane used randomness");
  } finally {
    fixture.close();
  }
}

export async function randomControls() {
  const nativeRandom = crypto.getRandomValues.bind(crypto);
  const descriptor = Object.getOwnPropertyDescriptor(crypto, "getRandomValues");
  const calls: number[] = [];
  const generated: Uint8Array[] = [];
  let fail = false;
  Object.defineProperty(crypto, "getRandomValues", {
    configurable: true,
    value(bytes: Uint8Array<ArrayBuffer>) {
      check(bytes.buffer instanceof ArrayBuffer, "Web Crypto requires unshared backing");
      calls.push(bytes.byteLength);
      nativeRandom(bytes);
      generated.push(bytes.slice());
      if (fail) throw new Error("injected random source failure");
      return bytes;
    },
  });
  try {
    const cases: string[] = [];
    for (const shared of [true, false]) {
      await exerciseMemory(shared, calls, generated, (value) => {
        fail = value;
      });
      cases.push(shared ? "shared" : "ordinary");
    }
    return { cases, calls };
  } finally {
    if (descriptor) Object.defineProperty(crypto, "getRandomValues", descriptor);
    else Reflect.deleteProperty(crypto, "getRandomValues");
  }
}
if (import.meta.main) console.log(JSON.stringify(await randomControls()));
