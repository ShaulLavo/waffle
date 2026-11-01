import assert from "node:assert/strict";
import { test } from "bun:test";
import { createRuntime } from "waffle";
import { FilesystemClient } from "waffle/fs";
import { PipeErrno } from "waffle/proc/pipes";
import type { ProgramPackage } from "waffle/programs";
import { coreutils } from "../src/index.ts";
import { teeCases, type TeeCase } from "../fixtures/tee-cases.ts";
import { observeNativeTee, verifyGnuTee } from "../scripts/tee-oracle.ts";
import {
  runFamilyAcceptance,
  type FamilyAcceptanceSession,
  type LaunchRequest,
} from "../../../tools/family-acceptance.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const readRights = (1n << 1n) | (1n << 21n) | (1n << 27n);
const writeRights = (1n << 6n) | (1n << 21n) | (1n << 27n);

function request(stdin: number, args: string[], executable = "/usr/bin/tee"): LaunchRequest {
  return {
    executable,
    argv: ["tee"].concat(args),
    cwd: "/work",
    env: { PATH: "/usr/bin:/bin", PWD: "/work", LC_ALL: "C", LANG: "C" },
    fds: [
      { child: 0, parent: stdin },
      { child: 1, parent: 1 },
      { child: 2, parent: 2 },
    ],
  };
}

async function setMode(session: FamilyAcceptanceSession, path: string, mode: number) {
  const client = new FilesystemClient(session.filesystem.fork());
  try {
    const root = await client.asyncCall("preopen", ["/"]);
    const resolved = await client.asyncCall("resolve", [root, path.replace(/^\//, "")]);
    assert.ok(resolved && typeof resolved === "object" && typeof resolved.node === "number");
    assert.equal(await client.asyncCall("setMode", [resolved.node, mode]), 0);
  } finally {
    client.dispose();
  }
}

async function fixture(session: FamilyAcceptanceSession, item: TeeCase) {
  const expected = observeNativeTee(item);
  await session.filesystem.remove("/work");
  await session.filesystem.mkdirp("/work");
  for (const [name, content] of Object.entries(item.files))
    await session.filesystem.writeFile(`/work/${name}`, content);
  if (item.denied) await setMode(session, `/work/${item.denied}`, 0o400);
  const stdin = session.filledPipe(item.input);
  const launched = request(stdin, item.args, "/bin/tee");
  if (item.closedStdout) launched.fds.splice(1, 1);
  try {
    const actual = await deadline(session.exec(launched));
    assert.equal(
      actual.exit.status,
      expected.status,
      `${item.name}: ${decoder.decode(actual.stderr)}`,
    );
    if (item.metadata) assert.match(decoder.decode(actual.stdout), /tee/);
    else assert.deepEqual(actual.stdout, new Uint8Array(expected.stdout), item.name);
    assert.equal(actual.stderr.length > 0, expected.stderr.length > 0, item.name);
    for (const [name, bytes] of Object.entries(expected.files))
      await compareFixtureFile(session, item, name, bytes);
    console.log(
      `GNU tee fixture: ${item.name}; status ${expected.status}; comparison ${item.comparison}`,
    );
  } finally {
    session.descriptors.close(stdin);
    if (item.denied) await setMode(session, `/work/${item.denied}`, 0o600);
  }
}

async function compareFixtureFile(
  session: FamilyAcceptanceSession,
  item: TeeCase,
  name: string,
  bytes: Uint8Array | null,
) {
  if (item.comparison === "gnu") return compareFile(session, name, bytes, item.name);
  assert.ok(bytes);
  assert.equal(bytes.length, 0, "GNU exit mode stops before the later output");
  await compareFile(
    session,
    name,
    item.input,
    "Pinned upstream finishes the current read slice before exit",
  );
}

async function compareFile(
  session: FamilyAcceptanceSession,
  name: string,
  bytes: Uint8Array | null,
  label: string,
) {
  if (bytes === null) {
    assert.equal(await session.filesystem.lookup(`/work/${name}`), undefined, label);
    return;
  }
  assert.deepEqual(
    await session.filesystem.readFile(`/work/${name}`),
    new Uint8Array(bytes),
    `${label}: ${name}`,
  );
}

async function deadline<T>(promise: Promise<T>, milliseconds = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("tee deadline exceeded")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function streaming(session: FamilyAcceptanceSession) {
  session.resetOutput();
  const [reader, writer] = session.pipe();
  const stdin = session.descriptors.open(reader, readRights, 0n);
  let running: Awaited<ReturnType<FamilyAcceptanceSession["spawn"]>> | undefined;
  let exited = false;
  try {
    running = await session.spawn(request(stdin, ["stream"]));
    void running.exit.then(() => {
      exited = true;
    });
    for (const text of ["first chunk\n", "second chunk\n", "third chunk\n"]) {
      assert.equal(writer.write([encoder.encode(text)]), encoder.encode(text).length);
      await session.waitForOutput(text);
      assert.equal(exited, false, "tee waited for EOF or exited before the producer closed");
    }
    writer.close();
    assert.equal((await deadline(running.exit)).status, 0);
    assert.equal(
      decoder.decode(await session.filesystem.readFile("/work/stream")),
      "first chunk\nsecond chunk\nthird chunk\n",
    );
  } finally {
    writer.close();
    if (running && !exited) running.interrupt();
    if (running) await deadline(running.exit);
    session.descriptors.close(stdin);
  }
}

async function brokenPipe(session: FamilyAcceptanceSession) {
  for (const [mode, status] of [
    ["warn", 1],
    ["warn-nopipe", 0],
  ] as const) {
    const [reader, writer] = session.pipe();
    reader.close();
    const stdout = session.descriptors.open(writer, writeRights, 0n);
    const stdin = session.filledPipe("after broken pipe\n");
    const launched = request(stdin, [`--output-error=${mode}`, "survivor"]);
    launched.fds[1] = { child: 1, parent: stdout };
    try {
      const actual = await deadline(session.exec(launched));
      assert.equal(actual.exit.status, status);
      assert.equal(actual.stderr.length > 0, status !== 0);
      assert.equal(
        decoder.decode(await session.filesystem.readFile("/work/survivor")),
        "after broken pipe\n",
      );
    } finally {
      session.descriptors.close(stdin);
      session.descriptors.close(stdout);
    }
  }
}

async function fillUntilBackpressure(
  session: FamilyAcceptanceSession,
  writer: ReturnType<FamilyAcceptanceSession["pipe"]>[1],
  output: ReturnType<FamilyAcceptanceSession["pipe"]>[0],
) {
  const chunk = new Uint8Array(64 * 1024).fill(65);
  const end = performance.now() + 5000;
  let stalled = 0;
  let sent = 0;
  while (stalled < 3) {
    assert.ok(performance.now() < end, "tee did not reach output backpressure");
    const count = writer.tryWrite([chunk]);
    if (count > 0) sent += count;
    else assert.equal(count, -PipeErrno.AGAIN, "input pipe returned an error other than EAGAIN");
    stalled = count < 0 && (output.readiness().nbytes ?? 0) >= chunk.length ? stalled + 1 : 0;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(sent >= 2 * chunk.length);
  assert.equal((await session.filesystem.lookup("/work/canceled"))?.kind, "file");
}

async function cancellation(session: FamilyAcceptanceSession, backpressure: boolean) {
  session.resetOutput();
  const [reader, writer] = session.pipe();
  const stdin = session.descriptors.open(reader, readRights, 0n);
  const [outputReader, outputWriter] = session.pipe();
  const stdout = session.descriptors.open(outputWriter, writeRights, 0n);
  const launched = request(stdin, ["-i", "canceled"]);
  if (backpressure) launched.fds[1] = { child: 1, parent: stdout };
  let running: Awaited<ReturnType<FamilyAcceptanceSession["spawn"]>> | undefined;
  let interrupted = false;
  try {
    running = await session.spawn(launched);
    if (backpressure) {
      await fillUntilBackpressure(session, writer, outputReader);
    } else {
      writer.write([encoder.encode("before cancellation\n")]);
      await session.waitForOutput("before cancellation\n");
    }
    running.interrupt();
    interrupted = true;
    assert.equal((await deadline(running.exit)).status, 130);
    console.log(
      `Canceled tee with ${backpressure ? "output backpressure" : "open stdin"}; status 130`,
    );
  } finally {
    if (running && !interrupted) running.interrupt();
    writer.close();
    outputReader.close();
    if (running) await deadline(running.exit);
    session.descriptors.close(stdin);
    session.descriptors.close(stdout);
  }
}

async function selected(session: FamilyAcceptanceSession, fetches: string[]) {
  const handle = session.runtime.programs.get("tee");
  assert.ok(handle);
  assert.deepEqual(
    session.runtime.programs.status().map((entry) => entry.name),
    ["tee"],
  );
  assert.equal(session.runtime.programs.get("/bin/tee"), handle);
  assert.equal(session.runtime.programs.get("/usr/bin/tee"), handle);
  assert.equal(handle.state.kind, "registered");
  assert.equal(fetches.length, 0);
  assert.equal(await session.filesystem.lookup("/usr/bin/echo"), undefined);
  await session.filesystem.mkdirp("/work");
  for (const item of teeCases) await fixture(session, item);
  await streaming(session);
  await brokenPipe(session);
  await cancellation(session, false);
  await cancellation(session, true);
  assert.equal(handle.state.kind, "loaded");
  assert.equal(fetches.length, 1);
  assert.ok(fetches[0]?.endsWith("/tee.wasm"));
  const supervisor = await (await session.runtime.processes()).ready();
  assert.ok(Array.from(supervisor.table.values()).every((record) => record.request === null));
  assert.equal(
    Array.from(supervisor.table.jobValues()).filter((job) => job.jobLifetime === "caller-fatal")
      .length,
    0,
  );
  assert.deepEqual(session.descriptors.inheritable(), [0, 1, 2]);
  await handle.remove();
  assert.equal(handle.state.kind, "removed");
  assert.equal(session.runtime.programs.get("tee"), undefined);
  assert.equal(await session.filesystem.lookup("/usr/bin/tee"), undefined);
  assert.equal(await session.filesystem.lookup("/bin/tee"), undefined);
}

test("pinned tee streams through actual Waffle workers, matches GNU fixtures, and releases aliases and canceled jobs", async () => {
  verifyGnuTee();
  const selection = coreutils.pick("tee", "/bin/tee", "/usr/bin/tee");
  assert.equal(selection.programs.length, 1);
  assert.equal(
    selection.programs[0],
    coreutils.programs.find((program) => program.path === "/usr/bin/tee"),
  );
  const fetches: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = new Proxy(original, {
    apply(target, receiver, args) {
      fetches.push(String(args[0]));
      return Reflect.apply(target, receiver, args);
    },
  });
  const runtime = createRuntime({
    filesystem: {
      mode: "memory",
      workerURL: new URL("../../waffle/browser/fs-worker.ts", import.meta.url),
    },
    programs: { onDemand: [selection] },
  });
  const empty: ProgramPackage = { name: "empty-tee-session", programs: [] };
  try {
    await runtime.programs.ready;
    await runFamilyAcceptance({
      runtime,
      workerUrl: new URL("../../waffle/browser/preview1-worker.ts", import.meta.url),
      assets: { coreutils: empty, findutils: empty, grep: empty, sed: empty, ripgrep: empty },
      cases: [
        { name: "selected tee", family: "coreutils", run: (session) => selected(session, fetches) },
      ],
    });
  } finally {
    await runtime.dispose();
    globalThis.fetch = original;
  }
  assert.equal(runtime.disposed, true);
}, 60_000);
