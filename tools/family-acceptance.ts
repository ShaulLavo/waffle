import type { Runtime, GuestLauncher, RuntimeSupervisor } from "waffle";
import { DescriptorTable } from "waffle/core/descriptors";
import type { DescriptorBinding, ProcessExit } from "waffle/proc/types";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
} from "waffle/proc/worker-client";
import { WorkerPipeHost } from "waffle/proc/worker-pipes";
import { installPrograms, type ProgramInstallation, type ProgramPackage } from "waffle/programs";
import cutTrFixture from "../packages/coreutils/fixtures/cut-tr.json" with { type: "json" };
import { seedFindTree } from "../packages/findutils/provenance/bash/tests/helpers/find-cases.ts";
import grepFixture from "../packages/grep/tests/fixtures/grep-usage-cases.json" with { type: "json" };
import { rgCases } from "../packages/ripgrep/tests/helpers/rg-fixtures.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PIPE_READ_RIGHTS = (1n << 1n) | (1n << 21n) | (1n << 27n);
const PATH = "/usr/bin:/bin";

export interface FamilyAcceptanceAssets {
  readonly coreutils: ProgramPackage;
  readonly findutils: ProgramPackage;
  readonly grep: ProgramPackage;
  readonly sed: ProgramPackage;
  readonly ripgrep: ProgramPackage;
}

export interface LaunchRequest {
  readonly executable: string;
  readonly argv: string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly fds: DescriptorBinding[];
}

type LaunchRecord = LaunchRequest;

export interface Execution {
  readonly exit: ProcessExit;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly launches: readonly LaunchRecord[];
}

export interface RunningProgram {
  readonly exit: Promise<ProcessExit>;
  readonly interrupt: () => void;
}

export interface FamilyAcceptanceCase {
  readonly name: string;
  readonly family: keyof FamilyAcceptanceAssets;
  readonly run: (session: FamilyAcceptanceSession) => Promise<void>;
}

export interface FamilyAcceptanceSession {
  readonly runtime: Runtime;
  readonly filesystem: Runtime["filesystem"];
  readonly descriptors: DescriptorTable;
  exec(request: LaunchRequest): Promise<Execution>;
  spawn(request: LaunchRequest): Promise<RunningProgram>;
  filledPipe(input: string | Uint8Array): number;
  pipe(): ReturnType<WorkerPipeHost["createPipe"]>;
  resetOutput(): void;
  waitForOutput(text: string): Promise<void>;
  dispose(): void;
}

export interface FamilyAcceptanceOptions {
  readonly runtime: Runtime;
  readonly workerUrl: URL;
  readonly assets: FamilyAcceptanceAssets;
  readonly cases?: readonly FamilyAcceptanceCase[];
}

interface InstalledSession {
  readonly session: FamilyAcceptanceSession;
  readonly installation: ProgramInstallation;
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function required<T>(value: T | undefined, label: string): T {
  assert(value !== undefined, `Missing frozen fixture: ${label}`);
  return value;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function bytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? encoder.encode(value) : value;
}

function base64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function request(argv: string[], cwd = "/", fds: DescriptorBinding[] = []): LaunchRequest {
  const program = required(argv[0], "argv[0]");
  return {
    executable: `/usr/bin/${program}`,
    argv,
    cwd,
    env: { PATH, PWD: cwd },
    fds,
  };
}

function stdinRequest(
  session: FamilyAcceptanceSession,
  argv: string[],
  input: string | Uint8Array,
): LaunchRequest {
  const parent = session.filledPipe(input);
  return request(argv, "/", [{ child: 0, parent }]);
}

function expectBytes(actual: Uint8Array, expected: string | Uint8Array, label: string) {
  const wanted = bytes(expected);
  assert(
    actual.length === wanted.length,
    `${label}: byte length ${actual.length} != ${wanted.length}`,
  );
  for (let index = 0; index < actual.length; index++) {
    assert(actual[index] === wanted[index], `${label}: byte ${index} differs`);
  }
}

function expectExit(exit: ProcessExit, code: number) {
  assert(
    exit.kind === "exited" && exit.code === code,
    `Unexpected process exit: ${JSON.stringify(exit)}`,
  );
}

function normalizedEnv(env: Record<string, string>) {
  return JSON.stringify(Object.entries(env).sort(([left], [right]) => left.localeCompare(right)));
}

function expectLaunch(result: Execution, expected: LaunchRequest) {
  assert(result.launches.length === 1, `Expected one launch, got ${result.launches.length}`);
  const actual = required(result.launches[0], "launch record");
  assert(actual.executable === expected.executable, "Executable changed at launch");
  assert(JSON.stringify(actual.argv) === JSON.stringify(expected.argv), "argv changed at launch");
  assert(actual.cwd === expected.cwd, `cwd changed at launch: ${actual.cwd}`);
  assert(normalizedEnv(actual.env) === normalizedEnv(expected.env), "env changed at launch");
  assert(
    JSON.stringify(actual.fds) === JSON.stringify(expected.fds),
    "Descriptor bindings changed",
  );
}

function expectExecution(
  result: Execution,
  launched: LaunchRequest,
  status: number,
  stdout: string | Uint8Array,
  stderr: string | Uint8Array = "",
) {
  expectExit(result.exit, status);
  expectBytes(result.stdout, stdout, "stdout");
  expectBytes(result.stderr, stderr, "stderr");
  expectLaunch(result, launched);
}

interface Output {
  readonly stdout: Uint8Array[];
  readonly stderr: Uint8Array[];
}

class Session implements FamilyAcceptanceSession {
  readonly filesystem: Runtime["filesystem"];

  constructor(
    readonly runtime: Runtime,
    private readonly service: Awaited<ReturnType<Runtime["processes"]>>,
    private readonly client: WorkerProcessClient,
    private readonly supervisor: RuntimeSupervisor,
    private readonly pid: number,
    private readonly pipes: WorkerPipeHost,
    private readonly notices: WorkerProcessMessage[],
    private readonly launches: LaunchRecord[],
    readonly descriptors: DescriptorTable,
    private readonly output: Output,
  ) {
    this.filesystem = runtime.filesystem;
  }

  private async flush() {
    for (;;) {
      const message = this.notices.shift();
      if (!message) return;
      await this.service.runtimeMessage(message, this.pid);
    }
  }

  private readonly children = new Set<number>();

  async spawn(launched: LaunchRequest): Promise<RunningProgram> {
    const child = this.client.spawn(this.pid, {
      executable: launched.executable,
      argv: launched.argv,
      env: launched.env,
      cwd: launched.cwd,
      job: -1,
      fds: launched.fds,
    });
    this.children.add(child);
    await this.flush();
    await this.supervisor.start(child);
    return {
      interrupt: () => {
        void this.service.kill(child, 2);
      },
      exit: this.supervisor
        .waitForExit(this.pid, child)
        .then(async (exit) => {
          this.client.wait(this.pid, child);
          await this.flush();
          return exit;
        })
        .finally(() => {
          this.children.delete(child);
        }),
    };
  }

  async exec(launched: LaunchRequest): Promise<Execution> {
    const stdout = this.output.stdout.length;
    const stderr = this.output.stderr.length;
    const launches = this.launches.length;
    const running = await this.spawn(launched);
    return {
      exit: await running.exit,
      stdout: concat(this.output.stdout.slice(stdout)),
      stderr: concat(this.output.stderr.slice(stderr)),
      launches: this.launches.slice(launches),
    };
  }

  filledPipe(input: string | Uint8Array): number {
    const [reader, writer] = this.pipes.createPipe();
    const payload = bytes(input);
    assert(writer.write([payload]) === payload.length, "Short acceptance pipe write");
    writer.close?.();
    return this.descriptors.open(reader, PIPE_READ_RIGHTS, 0n);
  }

  pipe() {
    return this.pipes.createPipe();
  }

  resetOutput() {
    this.output.stdout.length = 0;
    this.output.stderr.length = 0;
    this.launches.length = 0;
  }

  async waitForOutput(text: string) {
    const deadline = performance.now() + 10_000;
    while (!decoder.decode(concat(this.output.stdout)).includes(text)) {
      assert(performance.now() < deadline, `Timed out waiting for output: ${text}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  dispose() {
    for (const child of this.children) void this.service.kill(child, 9);
    this.children.clear();
    this.descriptors.dispose();
  }
}

function recordOutput(output: Output, fd: number, payload: Uint8Array) {
  if (fd === 1) output.stdout.push(Uint8Array.from(payload));
  else if (fd === 2) output.stderr.push(Uint8Array.from(payload));
}

async function createSession(runtime: Runtime, launches: LaunchRecord[]): Promise<Session> {
  const service = await runtime.processes();
  const transport = createWorkerProcessTransport({
    pid: runtime.identities.pid(),
    job: runtime.identities.job(),
    identity: runtime.identities.buffer,
  });
  transport.data = { filesystem: runtime.filesystem.createIdentity() };
  const output: Output = { stdout: [], stderr: [] };
  await service.adoptRuntimeRoot(transport, {
    output: (fd, payload) => recordOutput(output, fd, payload),
  });
  const notices: WorkerProcessMessage[] = [];
  const descriptors = new DescriptorTable();
  try {
    const pipes = new WorkerPipeHost({
      transport,
      postMessage: (message) => notices.push(message),
    });
    const client = new WorkerProcessClient({
      transport,
      descriptors,
      codec: pipes.codec(),
      prepareSpawn: (child) => {
        pipes.registry.registerProcess(child);
        return {
          data: {
            filesystem: runtime.filesystem.createIdentity(),
            pipeRegistry: pipes.registry.handle(),
          },
        };
      },
      postMessage: (message) => notices.push(message),
    });
    const supervisor = await service.ready();
    return new Session(
      runtime,
      service,
      client,
      supervisor,
      transport.pid,
      pipes,
      notices,
      launches,
      descriptors,
      output,
    );
  } catch (error) {
    descriptors.dispose();
    throw error;
  }
}

async function createInstalledSession(options: FamilyAcceptanceOptions): Promise<InstalledSession> {
  const { runtime, assets, workerUrl } = options;
  const launches: LaunchRecord[] = [];
  const launcher: GuestLauncher = (context, service) => {
    launches.push({
      executable: context.request.executable,
      argv: context.request.argv.slice(),
      cwd: context.request.cwd,
      env: { ...context.request.env },
      fds: context.request.fds.map(({ child, parent }) => ({ child, parent })),
    });
    return service.launchWorker(context, {
      workerUrl: workerUrl.href,
      request: {
        module: context.module,
        args: context.request.argv,
        env: context.request.env,
        interruptible: context.interruptible,
      },
    });
  };
  const packages = [assets.coreutils, assets.findutils, assets.grep, assets.sed, assets.ripgrep];
  const installation = await installPrograms(runtime, packages, { launcher });
  try {
    return { session: await createSession(runtime, launches), installation };
  } catch (error) {
    await installation.dispose();
    throw error;
  }
}

async function runCases(session: FamilyAcceptanceSession, cases: readonly FamilyAcceptanceCase[]) {
  const completed: string[] = [];
  for (const acceptanceCase of cases) {
    await acceptanceCase.run(session);
    completed.push(acceptanceCase.name);
  }
  return completed;
}

export async function runFamilyAcceptance(options: FamilyAcceptanceOptions): Promise<string[]> {
  const { session, installation } = await createInstalledSession(options);
  try {
    return await runCases(session, options.cases ?? familyAcceptanceCases);
  } finally {
    session.dispose();
    await installation.dispose();
  }
}

async function coreutils(session: FamilyAcceptanceSession) {
  const fixture = required(
    cutTrFixture.cases.find((entry) => entry.name === "cut relative file cwd"),
    "cut relative file cwd",
  );
  await session.filesystem.mkdirp("/work");
  await session.filesystem.writeFile("/work/cut-input", "a:b:c\n");
  const launched = request(["cut", "-d:", "-f2", "cut-input"], "/work");
  const result = await session.exec(launched);
  expectExecution(result, launched, fixture.status, base64(fixture.stdoutBase64));
}

async function find(session: FamilyAcceptanceSession) {
  await seedFindTree(session.runtime);
  const launched = request(["find", "sub", "-type", "f", "-size", "2c"], "/tree");
  const result = await session.exec(launched);
  expectExecution(result, launched, 0, "./sub/b.txt\n");
}

async function xargs(session: FamilyAcceptanceSession) {
  const launched = stdinRequest(session, ["xargs"], "one two\nthree\n");
  expectExecution(await session.exec(launched), launched, 0, "one two three\n");
}

async function grep(session: FamilyAcceptanceSession) {
  const fixture = required(
    grepFixture.find((entry) => entry.name === "numbered inverted ignore case"),
    "numbered inverted ignore case",
  );
  const launched = stdinRequest(session, ["grep", "-nvi", "hit"], "hit\nMISS\nHIT\n");
  const result = await session.exec(launched);
  expectExecution(result, launched, fixture.status, fixture.stdout);
  assert(!fixture.stderrPresent, "Frozen grep case unexpectedly requires stderr");
}

async function sed(session: FamilyAcceptanceSession) {
  const launched = stdinRequest(session, ["sed", "s/foo/ONE/"], "foo\nbar");
  expectExecution(await session.exec(launched), launched, 0, "ONE\nbar");
}

async function ripgrep(session: FamilyAcceptanceSession) {
  const fixture = required(
    rgCases.find((entry) => entry.name === "explicit stdin"),
    "ripgrep explicit stdin",
  );
  const launched = stdinRequest(session, ["rg", "-n", "needle", "-"], fixture.stdin);
  const result = await session.exec(launched);
  expectExecution(result, launched, fixture.status, fixture.stdout, fixture.error);
}

async function envDescriptors(session: FamilyAcceptanceSession) {
  const seven = session.filledPipe("one\ntwo\n");
  const forwarded = request(["env", "grep", "tw", "/dev/fd/7"], "/", [{ child: 7, parent: seven }]);
  expectExecution(await session.exec(forwarded), forwarded, 0, "two\n");
  const unbound = request(["cat", "/dev/fd/5"]);
  const missing = await session.exec(unbound);
  expectExit(missing.exit, 1);
  expectBytes(missing.stdout, "", "unbound descriptor stdout");
  expectLaunch(missing, unbound);
}

async function interruption(session: FamilyAcceptanceSession) {
  session.resetOutput();
  const [reader, writer] = session.pipe();
  try {
    const first = encoder.encode("first\n");
    assert(writer.write([first]) === first.length, "Short interruption pipe write");
    const stdin = session.descriptors.open(reader, PIPE_READ_RIGHTS, 0n);
    const running = await session.spawn(request(["cat"], "/", [{ child: 0, parent: stdin }]));
    await session.waitForOutput("first\n");
    running.interrupt();
    expectExit(await running.exit, 130);
  } finally {
    writer.close?.();
  }
}

export const familyAcceptanceCases: readonly FamilyAcceptanceCase[] = [
  { name: "coreutils cut cwd and shared filesystem", family: "coreutils", run: coreutils },
  { name: "find exact byte size", family: "findutils", run: find },
  { name: "xargs internal echo", family: "findutils", run: xargs },
  { name: "grep numbered inverted bytes", family: "grep", run: grep },
  { name: "sed unterminated output", family: "sed", run: sed },
  { name: "ripgrep explicit stdin", family: "ripgrep", run: ripgrep },
  {
    name: "env forwards descriptors and unbound fd fails",
    family: "coreutils",
    run: envDescriptors,
  },
  { name: "cat interrupted on an open pipe", family: "coreutils", run: interruption },
];
