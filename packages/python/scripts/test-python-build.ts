import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import {
  familyRecipe,
  familyTargetRoot,
  pythonBuildRecipe,
  repositoryRoot,
  withPythonWorkspace,
  stagePythonArtifact,
  stagePythonPayload,
  validatePythonPayload,
} from "./build-python.ts";
import { pythonSource, regularFiles, sha256, verifyPythonSource } from "./python-source.ts";
import { cappedWasiFixture } from "./wasi-artifact-fixture.ts";

function fixture(context: TestContext) {
  const parent = resolve(import.meta.dirname, "../.build");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(resolve(parent, "python-build-test-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const put = (name: string, bytes: string | Uint8Array) => {
    const path = resolve(directory, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  };
  put("initial-Lib/os.py", "# source os\n");
  put("initial-Lib/empty.py", "");
  put("initial-Lib/ensurepip/_bundled/example.whl", "unpruned wheel bytes");
  put("host/pybuilddir.txt", "build/lib.wasi-wasm32-3.15");
  put(
    "host/build/lib.wasi-wasm32-3.15/_sysconfigdata__wasi_wasm32.py",
    "build_time_vars = {'MACHDEP': 'wasi'}\n",
  );
  put("host/build/lib.wasi-wasm32-3.15/_sysconfig_vars__wasi_wasm32.json", '{"MACHDEP":"wasi"}');
  put("host/build/lib.wasi-wasm32-3.15/build-details.json", '{"source":"actual-generated-file"}');
  const output = resolve(directory, "artifact");
  stagePythonPayload(resolve(directory, "initial-Lib"), resolve(directory, "host"), output);
  return { directory, output, put };
}

test("CPython uses the singular helper with explicit monorepo and family roots", () => {
  assert.equal(familyRecipe.root, repositoryRoot);
  assert.equal(familyRecipe.waffle, resolve(repositoryRoot, "packages/waffle"));
  assert.equal(familyTargetRoot, resolve(import.meta.dirname, "../.build/python"));
  const source = readFileSync(new URL("./build-python.ts", import.meta.url), "utf8");
  assert.match(source, /wasiSysrootCommand\(familyRecipe\)/);
  assert.match(source, /wasiBuildConfiguration\(\{ \.\.\.familyRecipe, env \}\)/);
  assert.match(source, /verifyWasiGuest\(guest, \{ sdk: config\.sdk \}\)/);
  assert.doesNotMatch(source, /\.\/wasi-build\.ts|\.\/verify-wasi-guests\.ts/);
});

test("official build stages scope patched SDK34 flags to host configure and cap memory exactly", () => {
  const recipe = pythonBuildRecipe("/sdk34", "/patched-sysroot", {
    PATH: "/tools",
    CFLAGS: "foreign flags",
    LDFLAGS: "foreign link flags",
  });
  assert.deepEqual(
    recipe.map((step) => step.args[0]),
    [
      "configure-build-python",
      "make-build-python",
      "pythoninfo-build",
      "configure-host",
      "make-host",
      "pythoninfo-host",
    ],
  );
  for (const step of recipe) {
    assert.equal(step.env.WASI_SDK_PATH, "/sdk34");
    assert.equal(step.env.PATH, "/tools");
    assert.doesNotMatch(step.args.join(" "), /pthread|emscripten|import-memory|--wasi-sdk/);
    if (step.args[0] !== "configure-host") {
      assert.equal(step.env.CFLAGS, undefined);
      assert.equal(step.env.CPPFLAGS, undefined);
      assert.equal(step.env.LDFLAGS, undefined);
      continue;
    }
    assert.equal(step.env.CFLAGS, "--target=wasm32-wasip1 --sysroot=/patched-sysroot");
    assert.equal(step.env.CPPFLAGS, step.env.CFLAGS);
    assert.equal(step.env.LDFLAGS, `${step.env.CFLAGS} -Wl,--max-memory=268435456`);
  }
});

test("full initial Lib and actual generated tree are staged with relocatable URLs and byte hashes", (context) => {
  const { directory, output } = fixture(context);
  const manifest = validatePythonPayload(output);
  assert.equal(manifest.cpython, pythonSource.revision);
  assert.equal(manifest.argv0, pythonSource.argv0);
  assert.equal(manifest.files.length, 7);
  const empty = manifest.files.find((file) => file.path === "/Lib/empty.py");
  assert.deepEqual(empty, {
    path: "/Lib/empty.py",
    url: "python-files/Lib/empty.py",
    bytes: 0,
    sha256: sha256(""),
  });
  for (const file of manifest.files) {
    const bytes = readFileSync(resolve(output, file.url));
    assert.equal(file.bytes, bytes.length);
    assert.equal(file.sha256, sha256(bytes));
  }
  assert.equal(
    readFileSync(resolve(output, "python-files/cross-build/wasm32-wasip1/pybuilddir.txt"), "utf8"),
    readFileSync(resolve(directory, "host/pybuilddir.txt"), "utf8"),
  );
});

test("missing or redirected generated sysconfig files fail before a manifest can be published", (context) => {
  const { directory, put } = fixture(context);
  put("host/pybuilddir.txt", "../../outside");
  assert.throws(
    () =>
      stagePythonPayload(
        resolve(directory, "initial-Lib"),
        resolve(directory, "host"),
        resolve(directory, "bad"),
      ),
    /pybuilddir/,
  );
  put("host/pybuilddir.txt", "build/lib.wasi-wasm32-3.15");
  rmSync(resolve(directory, "host/build/lib.wasi-wasm32-3.15/_sysconfig_vars__wasi_wasm32.json"));
  assert.throws(
    () =>
      stagePythonPayload(
        resolve(directory, "initial-Lib"),
        resolve(directory, "host"),
        resolve(directory, "missing"),
      ),
    /sysconfig JSON/,
  );
});

test("payload validation rejects changed bytes, extra files, traversal and symbolic links", (context) => {
  const { directory, output, put } = fixture(context);
  put("artifact/python-files/Lib/os.py", "foreign bytes");
  assert.throws(() => validatePythonPayload(output), /\/Lib\/os.py/);
  put("artifact/python-files/Lib/os.py", "# source os\n");
  put("artifact/python-files/Lib/extra.py", "unexpected");
  assert.throws(() => validatePythonPayload(output), /tree differs/);
  rmSync(resolve(output, "python-files/Lib/extra.py"));
  symlinkSync(
    resolve(directory, "initial-Lib/os.py"),
    resolve(output, "python-files/Lib/linked.py"),
  );
  assert.throws(() => validatePythonPayload(output), /Not a regular file/);
  rmSync(resolve(output, "python-files/Lib/linked.py"));
  const manifest = validatePythonPayload(output);
  put(
    "artifact/python-stdlib.json",
    JSON.stringify({
      ...manifest,
      files: manifest.files.concat([
        {
          path: "/Lib/../outside",
          url: "python-files/Lib/../outside",
          bytes: 0,
          sha256: sha256(""),
        },
      ]),
    }),
  );
  assert.throws(() => validatePythonPayload(output));
});

test("a validated artifact stages without building and rejects an altered interpreter", (context) => {
  const { directory, output, put } = fixture(context);
  const interpreter = Buffer.concat([cappedWasiFixture, Uint8Array.of(0, 5, 4, 110, 97, 109, 101)]);
  put("artifact/python.wasm", interpreter);
  put("artifact/python.NOTICES.txt", "license text");
  put("artifact/python-licenses.json", "{}");
  const assets = Object.fromEntries(
    ["python.wasm", "python-stdlib.json", "python.NOTICES.txt", "python-licenses.json"].map(
      (name) => [name, sha256(readFileSync(resolve(output, name)))],
    ),
  );
  put(
    "artifact/python-build.json",
    JSON.stringify({
      cpython: pythonSource.revision,
      waffle: "d0c5f8a1a9a6723c2f9fccf5df8544b8aad84a00",
      sourcePatch: pythonSource.patch,
      assets,
    }),
  );
  const staged = resolve(directory, "staged");
  stagePythonArtifact(output, staged);
  assert.deepEqual(
    regularFiles(staged),
    regularFiles(output).concat(["python-program.json"]).sort(),
  );
  assert.deepEqual(readFileSync(resolve(staged, "python.wasm")), Buffer.from(cappedWasiFixture));
  assert.deepEqual(readFileSync(resolve(output, "python.wasm")), interpreter);
  assert.deepEqual(JSON.parse(readFileSync(resolve(staged, "python-program.json"), "utf8")), {
    operation: "strip-wasm-name-sections",
    producerReceiptSha256: sha256(readFileSync(resolve(output, "python-build.json"))),
    input: { bytes: interpreter.length, sha256: sha256(interpreter) },
    output: { bytes: cappedWasiFixture.length, sha256: sha256(cappedWasiFixture) },
  });
  for (const path of regularFiles(output).filter((name) => name !== "python.wasm"))
    assert.deepEqual(
      readFileSync(resolve(staged, path)),
      readFileSync(resolve(output, path)),
      path,
    );
  put(
    "artifact/python-build.json",
    JSON.stringify({
      cpython: pythonSource.revision,
      waffle: "d0c5f8a1a9a6723c2f9fccf5df8544b8aad84a00",
      sourcePatch: { ...pythonSource.patch, sha256: "0".repeat(64) },
      assets,
    }),
  );
  assert.throws(
    () => stagePythonArtifact(output, resolve(directory, "stale-startup")),
    /startup patch provenance/,
  );
  put("artifact/python.wasm", Uint8Array.from(cappedWasiFixture).slice(0, -1));
  assert.throws(() => stagePythonArtifact(output, resolve(directory, "altered")));
});

test("source correspondence checks reject a changed pinned input", (context) => {
  const { directory, put } = fixture(context);
  put("source/Include/patchlevel.h", '#define PY_VERSION "3.15.2"\n');
  put("source/Platforms/WASI/config.toml", 'host-triple = "wasm32-wasip1"\n');
  put(
    "third-party/cpython/provenance.json",
    JSON.stringify({
      appliedPatches: [pythonSource.patch],
      sourceCorrespondence: {
        "Platforms/WASI/config.toml": sha256('host-triple = "wasm32-wasip1"\n'),
      },
    }),
  );
  verifyPythonSource(directory, resolve(directory, "source"));
  put("source/Platforms/WASI/config.toml", "changed upstream source");
  assert.throws(
    () => verifyPythonSource(directory, resolve(directory, "source")),
    /Platforms\/WASI\/config.toml/,
  );
});

test("owned compiler scratch is removed after failure while caller data survives", async (context) => {
  const { directory, put } = fixture(context);
  put("scratch/caller.txt", "preserve");
  let created = "";
  await assert.rejects(
    withPythonWorkspace(resolve(directory, "scratch"), async (work) => {
      created = work;
      writeFileSync(resolve(work, "compiler-output"), "disposable");
      throw new Error("build failure");
    }),
    /build failure/,
  );
  assert.equal(readFileSync(resolve(directory, "scratch/caller.txt"), "utf8"), "preserve");
  assert.throws(() => readFileSync(resolve(created, "compiler-output")), /ENOENT/);
});
