import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { auditWaffleSource } from "./waffle-source.ts";
import {
  preparePythonSource,
  pythonNotices,
  pythonSource,
  regularFiles,
  sha256,
  type PythonPayloadFile,
  type PythonPayloadManifest,
} from "./python-source.ts";
import {
  stageProgram,
  verifyWasiGuest,
  wasiBuildConfiguration,
  wasiSysrootCommand,
  type WasiBuildRecipe,
} from "../../../tools/program-build-tools.ts";

const root = resolve(import.meta.dirname, "..");
export const repositoryRoot = resolve(root, "../..");
export const familyTargetRoot = resolve(root, ".build/python");
const waffleSourceRoot = resolve(repositoryRoot, "packages/waffle");
export const familyRecipe = {
  root: repositoryRoot,
  waffle: waffleSourceRoot,
} satisfies WasiBuildRecipe;
const buildPrefix = "cross-build/wasm32-wasip1";

export function pythonBuildRecipe(
  sdk: string,
  sysroot: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const nativeEnv: NodeJS.ProcessEnv = {
    ...env,
    WASI_SDK_PATH: sdk,
    SOURCE_DATE_EPOCH: "1792947471",
  };
  delete nativeEnv.CFLAGS;
  delete nativeEnv.CPPFLAGS;
  delete nativeEnv.LDFLAGS;
  const flags = `--target=wasm32-wasip1 --sysroot=${sysroot}`;
  const hostEnv: NodeJS.ProcessEnv = {
    ...nativeEnv,
    CFLAGS: flags,
    CPPFLAGS: flags,
    LDFLAGS: `${flags} -Wl,--max-memory=268435456`,
  };
  return [
    { args: ["configure-build-python", "--", "--config-cache"], env: nativeEnv },
    { args: ["make-build-python"], env: nativeEnv },
    { args: ["pythoninfo-build"], env: nativeEnv },
    { args: ["configure-host", "--", "--config-cache"], env: hostEnv },
    { args: ["make-host"], env: nativeEnv },
    { args: ["pythoninfo-host"], env: nativeEnv },
  ];
}

function payloadEntry(path: string, bytes: Uint8Array): PythonPayloadFile {
  return {
    path: `/${path}`,
    url: `python-files/${path}`,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

export function stagePythonPayload(
  initialLib: string,
  host: string,
  output: string,
): PythonPayloadManifest {
  const marker = readFileSync(resolve(host, "pybuilddir.txt"), "utf8");
  assert.equal(marker.trim(), "build/lib.wasi-wasm32-3.15", "Unexpected pybuilddir.txt");
  const generated = resolve(host, marker.trim());
  const generatedFiles = regularFiles(generated);
  assert.ok(
    generatedFiles.some((name) => /^_sysconfigdata_.*\.py$/.test(name)),
    "Missing generated sysconfig module",
  );
  assert.ok(
    generatedFiles.some((name) => /^_sysconfig_vars_.*\.json$/.test(name)),
    "Missing generated sysconfig JSON",
  );
  const files: PythonPayloadFile[] = [];
  const trees = [
    { source: initialLib, target: "Lib" },
    { source: generated, target: `${buildPrefix}/${marker.trim()}` },
  ];
  for (const tree of trees) {
    for (const name of regularFiles(tree.source)) {
      const path = `${tree.target}/${name}`;
      const destination = resolve(output, "python-files", path);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(resolve(tree.source, name), destination);
      files.push(payloadEntry(path, readFileSync(destination)));
    }
  }
  const markerPath = `${buildPrefix}/pybuilddir.txt`;
  const markerDestination = resolve(output, "python-files", markerPath);
  mkdirSync(dirname(markerDestination), { recursive: true });
  copyFileSync(resolve(host, "pybuilddir.txt"), markerDestination);
  files.push(payloadEntry(markerPath, readFileSync(markerDestination)));
  files.sort((a, b) => a.path.localeCompare(b.path, "en"));
  assert.ok(
    files.some((file) => file.path === "/Lib/os.py"),
    "Missing source stdlib",
  );
  const manifest: PythonPayloadManifest = {
    format: 1,
    cpython: pythonSource.revision,
    argv0: pythonSource.argv0,
    files,
  };
  writeFileSync(resolve(output, "python-stdlib.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "Expected an object");
  return Object.fromEntries(Object.entries(value));
}

export function validatePythonPayload(directory: string): PythonPayloadManifest {
  const manifest = object(
    JSON.parse(readFileSync(resolve(directory, "python-stdlib.json"), "utf8")),
  );
  assert.equal(manifest.format, 1);
  assert.equal(manifest.cpython, pythonSource.revision);
  assert.equal(manifest.argv0, pythonSource.argv0);
  assert.ok(Array.isArray(manifest.files));
  const files = manifest.files.map((value: unknown): PythonPayloadFile => {
    const file = object(value);
    assert.equal(typeof file.path, "string");
    assert.ok(
      typeof file.path === "string" &&
        /^\/(Lib\/|cross-build\/wasm32-wasip1\/(pybuilddir\.txt$|build\/lib\.wasi-wasm32-3\.15\/))/.test(
          file.path,
        ),
    );
    assert.ok(
      file.path
        .split("/")
        .every((part, index) => index === 0 || (part !== "" && part !== "." && part !== "..")),
    );
    assert.ok(!/[\\\0?#%]/.test(file.path), "Payload paths must be URL-safe");
    assert.equal(file.url, `python-files${file.path}`);
    assert.ok(
      typeof file.bytes === "number" && Number.isSafeInteger(file.bytes) && file.bytes >= 0,
    );
    assert.ok(typeof file.sha256 === "string" && /^[a-f0-9]{64}$/.test(file.sha256));
    const bytes = readFileSync(resolve(directory, `python-files${file.path}`));
    assert.equal(bytes.length, file.bytes, file.path);
    assert.equal(sha256(bytes), file.sha256, file.path);
    return {
      path: file.path,
      url: `python-files${file.path}`,
      bytes: file.bytes,
      sha256: file.sha256,
    };
  });
  assert.equal(
    new Set(files.map((file) => file.path)).size,
    files.length,
    "Duplicate payload paths",
  );
  const actual = regularFiles(resolve(directory, "python-files")).map((name) => `/${name}`);
  assert.deepEqual(
    actual,
    files.map((file) => file.path).sort(),
    "Payload tree differs from manifest",
  );
  assert.ok(actual.includes("/Lib/os.py"));
  const marker = readFileSync(
    resolve(directory, `python-files/${buildPrefix}/pybuilddir.txt`),
    "utf8",
  ).trim();
  assert.equal(marker, "build/lib.wasi-wasm32-3.15");
  assert.ok(
    actual.some(
      (name) =>
        name.startsWith(`/${buildPrefix}/${marker}/_sysconfigdata_`) && name.endsWith(".py"),
    ),
  );
  assert.ok(
    actual.some(
      (name) =>
        name.startsWith(`/${buildPrefix}/${marker}/_sysconfig_vars_`) && name.endsWith(".json"),
    ),
  );
  return { format: 1, cpython: pythonSource.revision, argv0: pythonSource.argv0, files };
}

export function stagePythonArtifact(source: string, output: string, sdk?: string) {
  const manifest = validatePythonPayload(source);
  verifyWasiGuest(resolve(source, "python.wasm"), sdk === undefined ? {} : { sdk });
  const receipt = object(JSON.parse(readFileSync(resolve(source, "python-build.json"), "utf8")));
  assert.equal(receipt.cpython, pythonSource.revision);
  assert.deepEqual(receipt.sourcePatch, pythonSource.patch, "Python startup patch provenance");
  const assets = object(receipt.assets);
  assert.deepEqual(Object.keys(assets).sort(), [
    "python-licenses.json",
    "python-stdlib.json",
    "python.NOTICES.txt",
    "python.wasm",
  ]);
  for (const [name, expected] of Object.entries(assets)) {
    assert.equal(sha256(readFileSync(resolve(source, name))), expected, name);
  }
  assert.notEqual(resolve(source), resolve(output), "Stage source and output must differ");
  const tree = resolve(output, "python-files");
  assert.ok(!existsSync(tree), `Refusing to replace an existing payload tree: ${tree}`);
  mkdirSync(output, { recursive: true });
  for (const name of Object.keys(assets)
    .filter((name) => name !== "python.wasm")
    .concat(["python-build.json"]))
    copyFileSync(resolve(source, name), resolve(output, name));
  const input = readFileSync(resolve(source, "python.wasm"));
  stageProgram(resolve(source, "python.wasm"), resolve(output, "python.wasm"));
  const finalized = readFileSync(resolve(output, "python.wasm"));
  const derivation = {
    operation: "strip-wasm-name-sections",
    producerReceiptSha256: sha256(readFileSync(resolve(source, "python-build.json"))),
    input: { bytes: input.length, sha256: sha256(input) },
    output: { bytes: finalized.length, sha256: sha256(finalized) },
  };
  writeFileSync(resolve(output, "python-program.json"), `${JSON.stringify(derivation, null, 2)}\n`);
  cpSync(resolve(source, "python-files"), tree, {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
  return manifest;
}

async function auditWaffle(work: string, output: string) {
  const runtimeIdentity = auditWaffleSource(repositoryRoot);
  const api = resolve(work, "waffle-api.mjs");
  await build({
    absWorkingDir: root,
    stdin: {
      contents: `export { Wasi } from ${JSON.stringify(resolve(waffleSourceRoot, "core/wasi.ts"))}; export { MemFS } from ${JSON.stringify(resolve(waffleSourceRoot, "fs/memory.ts"))};`,
      resolveDir: root,
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    conditions: ["browser"],
    outfile: api,
  });
  const script = `
import assert from "node:assert/strict";
import {dirname,resolve} from "node:path";
import {readFileSync} from "node:fs";
import {Wasi,MemFS} from ${JSON.stringify(pathToFileURL(api).href)};
const output=process.argv[1];
const module=new WebAssembly.Module(readFileSync(resolve(output,"python.wasm")));
const fs=new MemFS();
for(const file of JSON.parse(readFileSync(resolve(output,"python-stdlib.json"))).files) {
  fs.mkdirp(dirname(file.path));
  fs.writeFile(file.path,readFileSync(resolve(output,file.url)));
}
for(const [path,text] of Object.entries(${JSON.stringify(pythonGuestFiles)})) {
  fs.mkdirp(dirname(path)); fs.writeFile(path,text);
}
function run(fixture) {
  const out=[],err=[];
  let input=Buffer.from(fixture.input??"");
  const wasi=new Wasi({args:[${JSON.stringify(pythonSource.argv0)}].concat(fixture.args),env:{PYTHONDONTWRITEBYTECODE:"1",PWD:"/"},fs,preopens:{"/":"/"},stdout:bytes=>out.push(Buffer.from(bytes)),stderr:bytes=>err.push(Buffer.from(bytes)),stdin:cap=>{const chunk=input.subarray(0,cap);input=input.subarray(chunk.length);return chunk;},sleep(){throw Error("Unexpected blocking Python call");}});
  try {
    const imports=wasi.imports(module);
    for(const entry of WebAssembly.Module.imports(module)) {
      assert.equal(entry.kind,"function");
      assert.equal(typeof imports[entry.module]?.[entry.name],"function",entry.module+"."+entry.name);
    }
    const instance=new WebAssembly.Instance(module,imports);
    assert.ok(instance.exports.memory instanceof WebAssembly.Memory);
    const initialMemoryBytes=instance.exports.memory.buffer.byteLength;
    const status=wasi.start(instance);
    const stdout=Buffer.concat(out).toString(),stderr=Buffer.concat(err).toString();
    assert.equal(status,fixture.status,stderr);
    assert.equal(stdout,fixture.stdout);
    assert.equal(stderr,fixture.stderr??"");
    return {argv:fixture.args,status,stdout,stderr,initialMemoryBytes,finalMemoryBytes:instance.exports.memory.buffer.byteLength};
  } finally {wasi.descriptors.dispose();}
}
const qualification=${JSON.stringify(pythonUsageCases())}.map(run);
assert.equal(new TextDecoder().decode(fs.readFile("/home/guest/result.txt")),"PAYLOAD INPUT\\n");
console.log(JSON.stringify({imports:WebAssembly.Module.imports(module),exports:WebAssembly.Module.exports(module),nameSectionBytes:WebAssembly.Module.customSections(module,"name").map(section=>section.byteLength),preopens:{"/":"/"},waffle:${JSON.stringify(runtimeIdentity)},qualification}));
`;
  return object(
    JSON.parse(
      execFileSync(process.execPath, ["--input-type=module", "-e", script, output], {
        encoding: "utf8",
      }),
    ),
  );
}

const pythonGuestFiles = {
  "/home/guest/input.txt": "payload input\n",
  "/home/guest/python-case.py":
    'import pathlib,sys\nprint(sys.argv)\ndata=pathlib.Path("/home/guest/input.txt").read_text()\nprint(data,end="")\npathlib.Path("/home/guest/result.txt").write_text(data.upper())\nprint("script-stderr",file=sys.stderr)\nsys.exit(7)\n',
};

function pythonUsageCases() {
  return [
    { args: ["--version"], status: 0, stdout: "Python 3.15.2\n" },
    {
      args: [
        "-c",
        'import json,os,sys,sysconfig; print(sys.version.split()[0]); print(json.dumps({"ok":True})); print(os.getcwd()); print(sysconfig.get_python_version()); print(sysconfig.get_config_var("HOST_GNU_TYPE")); print(sysconfig.get_config_var("MACHDEP")); print(sys.executable); print(sys.argv)',
        "alpha",
      ],
      status: 0,
      stdout: `3.15.2\n{"ok": true}\n/\n3.15\nwasm32-unknown-wasip1\nwasi\n${pythonSource.argv0}\n['-c', 'alpha']\n`,
    },
    {
      args: [
        "-c",
        'import sys; print(sys.stdin.read().upper(),end=""); print("python-stderr",file=sys.stderr); sys.exit(7)',
      ],
      input: "from stdin\n",
      status: 7,
      stdout: "FROM STDIN\n",
      stderr: "python-stderr\n",
    },
    {
      args: ["/home/guest/python-case.py", "alpha"],
      status: 7,
      stdout: "['/home/guest/python-case.py', 'alpha']\npayload input\n",
      stderr: "script-stderr\n",
    },
  ];
}

function qualifyPythonWasmtime(output: string) {
  const scratchParent = resolve(root, ".build");
  mkdirSync(scratchParent, { recursive: true });
  const scratch = mkdtempSync(resolve(scratchParent, "python-qualification-"));
  try {
    cpSync(resolve(output, "python-files"), scratch, { recursive: true });
    for (const [path, text] of Object.entries(pythonGuestFiles)) {
      const destination = resolve(scratch, `.${path}`);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, text);
    }
    const args = [
      "run",
      "--argv0",
      pythonSource.argv0,
      "--dir",
      `${scratch}::/`,
      "--env",
      "PYTHONDONTWRITEBYTECODE=1",
      "--env",
      "PWD=/",
      resolve(output, "python.wasm"),
    ];
    const results = pythonUsageCases().map((fixture) => {
      const result = spawnSync("wasmtime", args.concat(fixture.args), {
        input: fixture.input,
        encoding: "utf8",
      });
      if (result.error) throw result.error;
      assert.equal(result.status, fixture.status, result.stderr);
      assert.equal(result.stdout, fixture.stdout);
      assert.equal(result.stderr, fixture.stderr ?? "");
      return {
        argv: fixture.args,
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    });
    assert.equal(
      readFileSync(resolve(scratch, "home/guest/result.txt"), "utf8"),
      "PAYLOAD INPUT\n",
    );
    return results;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function qualifyNativePython(source: string, work: string) {
  const builds = readdirSync(resolve(source, "cross-build")).filter(
    (name) => name !== "wasm32-wasip1",
  );
  assert.equal(builds.length, 1, "Expected one upstream build interpreter");
  const build = builds[0];
  assert.ok(build !== undefined, "Expected one upstream build interpreter");
  const python = resolve(source, "cross-build", build, "python");
  const args = [
    "-c",
    'import json,sys,sysconfig; print(sys.version.split()[0]); print(json.dumps({"ok":True})); print(sysconfig.get_python_version()); print(sys.stdin.read().upper(),end=""); print("oracle-stderr",file=sys.stderr); sys.exit(7)',
  ];
  const result = spawnSync(python, args, { input: "payload input\n", encoding: "utf8" });
  if (result.error) throw result.error;
  assert.equal(result.status, 7, result.stderr);
  assert.equal(result.stdout, '3.15.2\n{"ok": true}\n3.15\nPAYLOAD INPUT\n');
  assert.equal(result.stderr, "oracle-stderr\n");
  const evidence = {
    executableSha256: sha256(readFileSync(python)),
    argv: args,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
  writeFileSync(resolve(work, "native-oracle.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}

export async function withPythonWorkspace<T>(
  parent: string,
  run: (work: string) => Promise<T>,
): Promise<T> {
  mkdirSync(parent, { recursive: true });
  const work = mkdtempSync(resolve(parent, "run-"));
  try {
    return await run(work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function buildPython(output: string, parent: string) {
  return withPythonWorkspace(parent, (work) => runPythonBuild(output, work));
}

async function runPythonBuild(output: string, work: string) {
  auditWaffleSource(repositoryRoot);
  assert.ok(
    !existsSync(resolve(output, "python-stdlib.json")),
    "Use a fresh output directory or --stage an artifact",
  );
  const env = {
    ...process.env,
    WASI_LIBC_JOBS: "2",
    WASI_LIBC_SCRATCH_ROOT: work,
    TMPDIR: resolve(work, "tmp"),
    GIT_CEILING_DIRECTORIES: work,
  };
  mkdirSync(env.TMPDIR, { recursive: true });
  execFileSync(
    "python3",
    [
      "-X",
      "cpu_count=2",
      "-c",
      'import os; assert os.cpu_count() == 2, "Python 3.13+ with -X cpu_count support is required"',
    ],
    { env, stdio: "inherit" },
  );
  const { source, initialLib } = await preparePythonSource(root, work);
  const [command, args] = wasiSysrootCommand(familyRecipe);
  execFileSync(command, args, { cwd: repositoryRoot, env, stdio: "inherit" });
  const config = wasiBuildConfiguration({ ...familyRecipe, env });
  for (const library of [
    "libc.a",
    "libwasi-emulated-signal.a",
    "libwasi-emulated-getpid.a",
    "libwasi-emulated-process-clocks.a",
  ]) {
    assert.ok(existsSync(resolve(config.sysroot, "lib/wasm32-wasip1", library)), library);
  }
  const recipe = pythonBuildRecipe(config.sdk, config.sysroot, env);
  for (const step of recipe) {
    execFileSync("python3", ["-X", "cpu_count=2", "Platforms/WASI"].concat(step.args), {
      cwd: source,
      env: step.env,
      stdio: "inherit",
    });
  }
  const host = resolve(source, buildPrefix);
  const guest = resolve(host, "python.wasm");
  verifyWasiGuest(guest, { sdk: config.sdk });
  mkdirSync(output, { recursive: true });
  copyFileSync(guest, resolve(output, "python.wasm"));
  stagePythonPayload(initialLib, host, output);
  pythonNotices(source, output);
  const nativeOracle = qualifyNativePython(source, work);
  const receipt = await qualifyPythonArtifact(output, work, nativeOracle);
  writeFileSync(resolve(output, "python-build.json"), `${JSON.stringify(receipt, null, 2)}\n`);
}

async function qualifyPythonArtifact(output: string, work: string, nativeOracle: unknown = null) {
  auditWaffleSource(repositoryRoot);
  const config = wasiBuildConfiguration(familyRecipe);
  const recipe = pythonBuildRecipe(config.sdk, config.sysroot);
  verifyWasiGuest(resolve(output, "python.wasm"), { sdk: config.sdk });
  const manifest = validatePythonPayload(output);
  const audit = await auditWaffle(work, output);
  const qualification = qualifyPythonWasmtime(output);
  const assets = Object.fromEntries(
    ["python.wasm", "python-stdlib.json", "python.NOTICES.txt", "python-licenses.json"].map(
      (name) => [name, sha256(readFileSync(resolve(output, name)))],
    ),
  );
  const receipt = {
    cpython: pythonSource.revision,
    source: pythonSource,
    sourcePatch: pythonSource.patch,
    waffle: audit.waffle,
    sdk: readFileSync(resolve(config.sdk, "VERSION"), "utf8"),
    sysrootRecipe: config.identity,
    recipe: recipe.map((step) => ({
      args: step.args,
      CFLAGS: step.env.CFLAGS,
      CPPFLAGS: step.env.CPPFLAGS,
      LDFLAGS: step.env.LDFLAGS,
    })),
    assets,
    interpreterBytes: readFileSync(resolve(output, "python.wasm")).length,
    payloadFiles: manifest.files.length,
    payloadBytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0),
    audit,
    qualification,
    memoryMaximumBytes: 268435456,
    nativeOracle,
    qualificationTools: {
      node: process.version,
      wasmtime: execFileSync("wasmtime", ["--version"], { encoding: "utf8" }).trim(),
      buildDriverPython: execFileSync("python3", ["--version"], { encoding: "utf8" }).trim(),
    },
    transfer: {
      encoding:
        "gzip, one independent response per manifest entry; illustrative compression only, not a server configuration",
      interpreterGzipBytes: gzipSync(readFileSync(resolve(output, "python.wasm"))).length,
      manifestBytes: readFileSync(resolve(output, "python-stdlib.json")).length,
      manifestGzipBytes: gzipSync(readFileSync(resolve(output, "python-stdlib.json"))).length,
      payloadGzipBytes: manifest.files.reduce(
        (sum, file) => sum + gzipSync(readFileSync(resolve(output, file.url))).length,
        0,
      ),
    },
  };
  validatePythonPayload(output);
  console.log(`Qualified CPython artifact: ${output}`);
  return receipt;
}

export async function qualifyExistingPythonArtifact(options: {
  artifact: string;
  work: string;
  evidence: string;
  nativeOracle?: unknown;
}) {
  const original = readFileSync(resolve(options.artifact, "python-build.json"));
  const producer = object(JSON.parse(original.toString()));
  assert.equal(producer.cpython, pythonSource.revision);
  assert.deepEqual(producer.sourcePatch, pythonSource.patch);
  for (const [name, hash] of Object.entries(object(producer.assets)))
    assert.equal(sha256(readFileSync(resolve(options.artifact, name))), hash, name);
  const qualification = await qualifyPythonArtifact(
    options.artifact,
    options.work,
    options.nativeOracle ?? producer.nativeOracle,
  );
  const evidence = {
    producerReceiptSha256: sha256(original),
    producer,
    runtime: qualification.waffle,
    assets: qualification.assets,
    audit: qualification.audit,
    qualification: qualification.qualification,
    qualificationTools: qualification.qualificationTools,
    transfer: qualification.transfer,
  };
  writeFileSync(options.evidence, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  assert.deepEqual(readFileSync(resolve(options.artifact, "python-build.json")), original);
}

function cli() {
  const args = process.argv.slice(2);
  let output = resolve(root, "dist");
  let stage: string | undefined;
  let qualify: string | undefined;
  let work = familyTargetRoot;
  while (args.length) {
    const option = args.shift();
    const value = args.shift();
    assert.ok(value, `Missing value for ${option}`);
    if (option === "--output") output = resolve(value);
    else if (option === "--stage") stage = resolve(value);
    else if (option === "--qualify") qualify = resolve(value);
    else if (option === "--work") work = resolve(value);
    else throw new Error(`Unknown option: ${option}`);
  }
  assert.ok(!(stage && qualify), "Choose either --stage or --qualify");
  if (stage) return stagePythonArtifact(stage, output);
  if (qualify)
    return withPythonWorkspace(work, (scratch) =>
      qualifyExistingPythonArtifact({ artifact: qualify, work: scratch, evidence: output }),
    );
  return buildPython(output, work);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await cli();
