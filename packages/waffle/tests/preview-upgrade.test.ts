import { expect, test } from "bun:test";
import { PreviewRouter, type PreviewServer } from "../browser/preview";
import type { ConnectionSink } from "../browser/net/helper";
import type { PreviewHostExchange, PreviewHostOutput, PreviewHostRelay, PreviewSocketRequest } from "../browser/preview-host";

const target = "https://preview.example.test";
const source = "https://sibling.example.test";
const sink: ConnectionSink = { data() {}, end() {}, error() {} };
const decoder = new TextDecoder();
const encoder = new TextEncoder();

async function fixture() {
  const origins = new Map([[3000, target], [5173, source]]);
  const writes: string[] = [];
  const ports: number[] = [];
  const server: PreviewServer = {
    request() { throw new Error("Unexpected HTTP adapter"); },
    connect(port) {
      ports.push(port);
      return { write(bytes) { writes.push(decoder.decode(bytes)); }, close() {} };
    },
  };
  const router = new PreviewRouter({ mode: "root", originForPort: port => origins.get(port) ?? "" });
  router.register(3000, server);
  router.register(5173, server);
  const lifetime = new AbortController();
  const host = await router.bindHost({ port: 3000, signal: lifetime.signal });
  const sibling = await router.bindHost({ port: 5173 });
  return { router, host, sibling, server, origins, writes, ports, lifetime, close() { host.close(); sibling.close(); } };
}

function request(headers: [string, string][] = []): PreviewSocketRequest {
  return { method: "GET", url: `${target}/hmr?q=a%2Bb`, headers };
}

function dispatch(host: PreviewHostRelay, input: PreviewSocketRequest, trailing: string[] = []) {
  const messages: PreviewHostOutput[] = [];
  const exchange: PreviewHostExchange = {
    onmessage: null,
    close() {},
    postMessage(message) {
      messages.push(message);
      if (message.type !== "accepted") return;
      for (const chunk of trailing) exchange.onmessage?.({ type: "data", chunk: encoder.encode(chunk) });
      exchange.onmessage?.({ type: "end" });
    },
  };
  const completed = host.dispatch({ type: "socket", authorization: host.authorization, ...input }, exchange);
  return { messages, completed };
}

test("W1 W9 W12 structured direct and dispatched upgrades serialize once before trailing bytes", async () => {
  const f = await fixture();
  const input = request([["X-First", "a"], ["hOsT", "preview.example.test"], ["oRiGiN", target], ["Connection", "Upgrade"], ["Upgrade", "websocket"], ["X-First", "b"]]);
  const head = "GET /hmr?q=a%2Bb HTTP/1.1\r\nHost: localhost:3000\r\nOrigin: http://localhost:3000\r\nX-First: a\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nX-First: b\r\n\r\n";
  try {
    const connection = f.host.connect(f.host.authorization, input, sink);
    expect(f.writes).toEqual([head]);
    connection?.close();
    f.writes.length = 0;
    const wire = dispatch(f.host, input, ["trailing-head", "later-data"]);
    await wire.completed;
    expect(wire.messages.map(message => message.type)).toEqual(["accepted", "end"]);
    expect(f.writes).toEqual([head, "trailing-head", "later-data"]);
    expect(f.ports).toEqual([3000, 3000]);
  } finally { f.close(); }
});

test("W2 W3 sibling ports retain their source authority and absent Origin stays absent", async () => {
  const f = await fixture();
  try {
    const wire = dispatch(f.host, request([["Origin", source]]));
    await wire.completed;
    expect(f.writes[0]).toContain("Host: localhost:3000\r\nOrigin: http://localhost:5173\r\n");
    const absent = dispatch(f.host, request());
    await absent.completed;
    expect(f.writes[1]).toBe("GET /hmr?q=a%2Bb HTTP/1.1\r\nHost: localhost:3000\r\n\r\n");
  } finally { f.close(); }
});

for (const value of ["https://foreign.invalid", "null", `${target}/`, "https://PREVIEW.example.test", "https://preview.example.test:443", ` ${target}`, `${target} `, `${target}/path`, "http://localhost:3000"]) {
  test(`W4 Origin ${JSON.stringify(value)} rejects before connect and acceptance`, async () => {
    const f = await fixture();
    try {
      const wire = dispatch(f.host, request([["Origin", value]]));
      await wire.completed;
      expect(wire.messages.map(message => message.type)).toEqual(["error"]);
      expect(() => f.host.connect(f.host.authorization, request([["Origin", value]]), sink)).toThrow();
      expect(f.ports).toEqual([]);
      expect(f.writes).toEqual([]);
    } finally { f.close(); }
  });
}

for (const headers of [
  [["Origin", target], ["origin", target]],
  [["Host", "preview.example.test"], ["HOST", "preview.example.test"]],
  [["X-Test", "a\rb"]], [["X-Test", "a\nb"]], [["bad name", "value"]],
  [["Origin", `${target}, ${source}`]],
] satisfies [string, string][][]) {
  test(`W5 invalid upgrade pairs ${JSON.stringify(headers)} never connect`, async () => {
    const f = await fixture();
    try {
      const wire = dispatch(f.host, request(headers));
      await wire.completed;
      expect(wire.messages.map(message => message.type)).toEqual(["error"]);
      expect(f.ports).toEqual([]);
    } finally { f.close(); }
  });
}

test("W4 an origin live in a different router is not owned", async () => {
  const f = await fixture();
  const foreign = new PreviewRouter({ mode: "root", originForPort: () => "https://other-owner.example.test" });
  foreign.register(3000, f.server);
  const other = await foreign.bindHost({ port: 3000 });
  try {
    const wire = dispatch(f.host, request([["Origin", other.origin]]));
    await wire.completed;
    expect(wire.messages.map(message => message.type)).toEqual(["error"]);
    expect(f.ports).toEqual([]);
  } finally { other.close(); f.close(); }
});

test("W6 W7 lookup follows unregister and rebind instead of keeping an origin snapshot", async () => {
  const f = await fixture();
  let replacement: PreviewHostRelay | undefined;
  try {
    f.router.unregister(5173, f.server);
    const retired = dispatch(f.host, request([["Origin", source]]));
    await retired.completed;
    expect(retired.messages.map(message => message.type)).toEqual(["error"]);
    f.origins.set(5173, "https://replacement.example.test");
    f.router.register(5173, f.server);
    replacement = await f.router.bindHost({ port: 5173 });
    const live = dispatch(f.host, request([["Origin", replacement.origin]]));
    await live.completed;
    expect(f.writes[0]).toContain("Origin: http://localhost:5173\r\n");
    const old = dispatch(f.host, request([["Origin", source]]));
    await old.completed;
    expect(old.messages.map(message => message.type)).toEqual(["error"]);
    expect(f.ports).toEqual([3000]);
  } finally { replacement?.close(); f.close(); }
});

test("W8 a closed source, aborted owner and closed target reject before connect", async () => {
  const f = await fixture();
  try {
    f.sibling.close();
    await dispatch(f.host, request([["Origin", source]])).completed;
    expect(f.ports).toEqual([]);
    f.lifetime.abort();
    const aborted = dispatch(f.host, request([["Origin", target]]));
    await aborted.completed;
    expect(aborted.messages.map(message => message.type)).toEqual(["error"]);
    expect(() => f.host.connect(f.host.authorization, request(), sink)).toThrow("closed");
    expect(f.ports).toEqual([]);
  } finally { f.close(); }
});

test("W11 invalid methods and off-origin URLs fail before connect", async () => {
  const f = await fixture();
  try {
    for (const input of [{ ...request(), method: "GET\r\nInjected" }, { ...request(), url: `${source}/hmr` }]) {
      const wire = dispatch(f.host, input);
      await wire.completed;
      expect(wire.messages.map(message => message.type)).toEqual(["error"]);
    }
    expect(f.ports).toEqual([]);
  } finally { f.close(); }
});
