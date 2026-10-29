import { expect, test } from "bun:test";
import { PreviewRouter } from "../browser/preview";
import type { PreviewHostExchange, PreviewHostOutput } from "../browser/preview-host";

const origin = "https://review.example.test";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const writeError = new Error("head write failed");
const connectError = new Error("connect failed");
const sink = { data() {}, end() {}, error() {} };
const request = { url: `${origin}/hmr`, method: "GET", headers: [] };

type TransportMode = "write-throw" | "write-and-close-throw" | "connect-throw" | "sync";

async function fixture(mode: TransportMode) {
  const state = { connects: 0, closes: 0, writes: 0 };
  const router = new PreviewRouter({ mode: "root", originForPort: () => origin });
  router.register(3000, {
    request() { throw new Error("unexpected HTTP path"); },
    connect(_port, output) {
      state.connects++;
      if (mode === "connect-throw") throw connectError;
      return {
        write() {
          state.writes++;
          if (mode !== "sync") throw writeError;
          void output.data(encoder.encode(state.writes === 1 ? "head-response" : "duplex-response"));
        },
        close() {
          state.closes++;
          if (mode === "write-and-close-throw") throw new Error("close failed");
        },
      };
    },
  });
  return { host: await router.bindHost({ port: 3000 }), state };
}

function exchange(messages: PreviewHostOutput[]): PreviewHostExchange {
  return { onmessage: null, close() {}, postMessage(message) { messages.push(message); } };
}

for (const mode of ["write-throw", "write-and-close-throw"] satisfies TransportMode[]) {
  test(`${mode}: direct initialization preserves write failure and closes immediately`, async () => {
    const f = await fixture(mode);
    try {
      expect(() => f.host.connect(f.host.authorization, request, sink)).toThrow(writeError);
      expect(f.state).toEqual({ connects: 1, closes: 1, writes: 1 });
    } finally { f.host.close(); }
    expect(f.state.closes).toBe(1);
  });

  test(`${mode}: dispatched initialization closes before returning its original error`, async () => {
    const f = await fixture(mode);
    const messages: PreviewHostOutput[] = [];
    try {
      await f.host.dispatch({ type: "socket", authorization: f.host.authorization, ...request }, exchange(messages));
      expect(messages).toEqual([{ type: "error", message: writeError.message }]);
      expect(f.state).toEqual({ connects: 1, closes: 1, writes: 1 });
    } finally { f.host.close(); }
    expect(f.state.closes).toBe(1);
  });
}

test("synchronous connection failure emits its error without acceptance", async () => {
  const f = await fixture("connect-throw");
  const messages: PreviewHostOutput[] = [];
  try {
    await f.host.dispatch({ type: "socket", authorization: f.host.authorization, ...request }, exchange(messages));
    expect(messages).toEqual([{ type: "error", message: connectError.message }]);
    expect(f.state).toEqual({ connects: 1, closes: 0, writes: 0 });
  } finally { f.host.close(); }
});

for (const trigger of ["accepted", "head-response"]) {
  test(`synchronous ${trigger} input cannot overtake buffered upgrade output`, async () => {
    const f = await fixture("sync");
    const messages: string[] = [];
    const wire: PreviewHostExchange = {
      onmessage: null,
      close() {},
      postMessage(message) {
        const value = message.type === "data" ? decoder.decode(message.chunk) : message.type;
        messages.push(value);
        if (value !== trigger) return;
        wire.onmessage?.({ type: "data", chunk: encoder.encode("trailing") });
        wire.onmessage?.({ type: "end" });
      },
    };
    try {
      await f.host.dispatch({ type: "socket", authorization: f.host.authorization, ...request }, wire);
      expect(messages).toEqual(["accepted", "head-response", "duplex-response", "end"]);
      expect(f.state).toEqual({ connects: 1, closes: 1, writes: 2 });
    } finally { f.host.close(); }
  });
}
