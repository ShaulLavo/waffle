import { open, until } from "./page.js";

type Session = Awaited<ReturnType<typeof open>>;
type Child = Awaited<ReturnType<Session["launch"]>>;
type Result = Awaited<ReturnType<Child["finish"]>>;
type Variant = "generated" | "handwritten";

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

function exit(result: Result, kind: string, code: number) {
  equal(result.exit.kind, kind);
  equal(result.exit.code, code);
}

async function ready(child: Child) {
  await until(
    () => child.drain().includes("ready\n") || !child.live(),
    "guest to hold a live resource",
  );
  if (!child.live()) throw new Error(JSON.stringify(await child.finish()));
}

async function resize(state: Session, program: Variant) {
  state.resize(320, 200);
  const old = state.expected();
  const child = await state.launch(program);
  await ready(child);
  state.resize(448, 256);
  const next = state.expected();
  child.feed();
  const result = await child.finish();
  exit(result, "exited", 0);
  const lines = result.text.trim().split("\n");
  equal(lines, [old, "ready", next, next, "released"]);
  equal(
    result.events,
    program === "generated" ? ["evaluated", { outstanding: 0, remaining: 0, drops: 2 }] : [],
  );
  return lines;
}

async function resource(state: Session, mode: "revoke" | "retire" | "cancel") {
  const child = await state.launch("generated", mode === "cancel" ? "retire" : mode);
  await ready(child);
  if (mode === "revoke") child.revoke();
  if (mode === "cancel") await child.kill();
  else child.feed();
  const result = await child.finish();
  exit(result, mode === "cancel" ? "signaled" : "exited", mode === "cancel" ? 9 : 0);
  equal(result.events, [
    "evaluated",
    {
      outstanding: mode === "revoke" ? 0 : 1,
      remaining: 0,
      drops: mode === "revoke" ? 1 : 0,
    },
  ]);
  if (mode === "revoke") equal(result.text.endsWith("revoked\n"), true);
  return result;
}

async function failure(state: Session, name: "startup" | "stale" | "double-drop") {
  const result = await (await state.launch(name)).finish();
  const startup = name === "startup";
  exit(result, startup ? "start-failed" : "exited", startup ? 5 : 1);
  equal(result.events, [
    "evaluated",
    {
      outstanding: startup ? 0 : 1,
      remaining: 0,
      drops: startup ? 0 : 1,
    },
  ]);
  if (!startup && !result.text.includes("Unknown resource handle 1"))
    throw new Error(JSON.stringify({ name, ...result }));
  return { name, ...result };
}

async function bench(state: Session, program: Variant) {
  const result = await (await state.launch(program, "bench")).finish();
  exit(result, "exited", 0);
  const lines = result.text.split("\n").filter((line) => line.startsWith("batch "));
  equal(lines.length, 7);
  return lines.map((line) => {
    const [, time, sum] = line.split(" ");
    equal(sum, "32000000");
    return Number(time) / 100_000;
  });
}

async function recordLifetimes(state: Session) {
  const peer = await state.launch("peer");
  const revoke = await resource(state, "revoke");
  equal(peer.live(), true);
  const retire = await resource(state, "retire");
  equal(peer.live(), true);
  const cancel = await resource(state, "cancel");
  equal(peer.live(), true);
  const failures = [
    await failure(state, "startup"),
    await failure(state, "stale"),
    await failure(state, "double-drop"),
  ];
  peer.feed();
  const peerResult = await peer.finish();
  exit(peerResult, "exited", 0);
  equal(peerResult.events, []);
  equal(state.errors.length, 1);
  if (!state.errors[0]?.includes("unsupported import surface-fixture.missing"))
    throw new Error(JSON.stringify(state.errors));
  return { revoke, retire, cancel, failures, peer: peerResult.exit };
}

export async function run(ordinaryDone: () => Promise<void>) {
  const state = await open();
  try {
    const ordinary = await state.launch("peer");
    ordinary.feed();
    const plain = await ordinary.finish();
    exit(plain, "exited", 0);
    equal(plain.events, []);

    const handwritten = await resize(state, "handwritten");
    await ordinaryDone();
    const generated = await resize(state, "generated");
    equal(handwritten, generated);

    const lifetimes = await recordLifetimes(state);
    state.resize(320, 200);
    const timings = {
      handwritten: await bench(state, "handwritten"),
      generated: await bench(state, "generated"),
    };
    equal(
      state.urls.some((path) => path.includes("service-worker")),
      false,
    );
    return {
      generated,
      handwritten,
      ...lifetimes,
      timings,
      errors: state.errors,
      workers: state.urls,
    };
  } finally {
    await state.close();
  }
}
