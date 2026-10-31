import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

export const pythonSource = Object.freeze({
  version: "3.15.2",
  revision: "5e58eaad7c58df58dfa8ea549c87996e01dd1077",
  tag: "v3.15.2",
  tagObject: "a4ed3466611d5941876ff91610601eb29543a5ff",
  archiveUrl: "https://www.python.org/ftp/python/3.15.2/Python-3.15.2.tar.xz",
  archiveSha256: "8b5536d280142ecf6cdfe15d12a21ba1c65e300bbf7b28a8d0cdb849575797de",
  archiveBytes: 27960396,
  argv0: "/cross-build/wasm32-wasip1/python.wasm",
  patch: Object.freeze({
    path: "patches/cpython-wasi-cwd.patch",
    target: "Modules/main.c",
    sha256: "b85dda59d0aef994c3e2b9b1cf09bd2f121d31c79363094ed638051965773c1b",
    upstreamSha256: "724ebf378f2d33974ed8342d3ffba755ddbf6d9b14e0253563ca28e6190c5adc",
    patchedSha256: "ce326dfb6fa4843c26b120cbaee8d8ed5e108be5eafd620be113b3776faf0ec5",
  }),
});

export interface PythonPayloadFile {
  readonly path: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface PythonPayloadManifest {
  readonly format: 1;
  readonly cpython: typeof pythonSource.revision;
  readonly argv0: typeof pythonSource.argv0;
  readonly files: readonly PythonPayloadFile[];
}

export function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function regularFiles(directory: string, prefix = ""): string[] {
  return readdirSync(resolve(directory, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return regularFiles(directory, name);
      assert.ok(entry.isFile(), `Not a regular file: ${name}`);
      return [name];
    })
    .sort();
}

export function verifyPythonSource(root: string, source: string) {
  const receipt: unknown = JSON.parse(
    readFileSync(resolve(root, "third-party/cpython/provenance.json"), "utf8"),
  );
  assert.ok(receipt && typeof receipt === "object" && "sourceCorrespondence" in receipt);
  assert.deepEqual(
    receipt && typeof receipt === "object" && "appliedPatches" in receipt
      ? receipt.appliedPatches
      : undefined,
    [pythonSource.patch],
  );
  assert.ok(receipt.sourceCorrespondence && typeof receipt.sourceCorrespondence === "object");
  for (const [path, hash] of Object.entries(receipt.sourceCorrespondence)) {
    assert.equal(sha256(readFileSync(resolve(source, path))), hash, path);
  }
  assert.match(
    readFileSync(resolve(source, "Include/patchlevel.h"), "utf8"),
    /#define PY_VERSION\s+"3\.15\.2"/,
  );
}

function applyPythonSourcePatch(root: string, source: string) {
  const patch = pythonSource.patch;
  const patchPath = resolve(root, patch.path);
  assert.equal(sha256(readFileSync(patchPath)), patch.sha256, patch.path);
  const target = resolve(source, patch.target);
  assert.equal(sha256(readFileSync(target)), patch.upstreamSha256, patch.target);
  execFileSync("git", ["apply", patchPath], {
    cwd: source,
    env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(realpathSync(source)) },
  });
  assert.equal(sha256(readFileSync(target)), patch.patchedSha256, patch.target);
}

export async function preparePythonSource(root: string, work: string) {
  const archive = resolve(work, "source.tar.xz");
  mkdirSync(work, { recursive: true });
  if (!existsSync(archive)) {
    const response = await fetch(pythonSource.archiveUrl);
    assert.ok(response.ok, `CPython download failed: ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(bytes.byteLength, pythonSource.archiveBytes);
    assert.equal(sha256(bytes), pythonSource.archiveSha256);
    writeFileSync(archive, bytes, { flag: "wx" });
  }
  assert.equal(sha256(readFileSync(archive)), pythonSource.archiveSha256);
  const source = resolve(work, "source");
  assert.ok(!existsSync(source), `Use a fresh Python work directory: ${source}`);
  mkdirSync(source);
  execFileSync("tar", ["-xJf", archive, "--strip-components=1", "-C", source]);
  verifyPythonSource(root, source);
  applyPythonSourcePatch(root, source);
  const initialLib = resolve(work, "initial-Lib");
  cpSync(resolve(source, "Lib"), initialLib, { recursive: true, errorOnExist: true, force: false });
  return { source, initialLib };
}

export function pythonNotices(source: string, output: string) {
  execFileSync(
    "python3",
    [
      "-c",
      String.raw`
import hashlib,json,pathlib,re,sys,zipfile
source=pathlib.Path(sys.argv[1]); output=pathlib.Path(sys.argv[2])
records=[]; sections=["# CPython 3.15.2 and full initial standard library notices\n"]
def include(name,data):
    records.append({"path":name,"bytes":len(data),"sha256":hashlib.sha256(data).hexdigest()})
    sections.append("## "+name+"\n\n"+data.decode("utf-8",errors="replace")+"\n")
for name in ["LICENSE","Doc/license.rst","Modules/expat/COPYING"]:
    include(name,(source/name).read_bytes())
def wheel_notices(path,relative):
    with zipfile.ZipFile(path) as wheel:
        for name in sorted(wheel.namelist()):
            if name.endswith("/"): continue
            if not re.search(r"(^|/)(licenses?|copying|notice|authors)([./_-]|$)|\.dist-info/METADATA$",name,re.I): continue
            include(relative+"!"+name,wheel.read(name))
for path in sorted((source/"Lib").rglob("*")):
    if not path.is_file(): continue
    relative=path.relative_to(source).as_posix()
    if re.search(r"(^|/)(license|copying|notice)([./_-]|$)",relative,re.I):
        include(relative,path.read_bytes())
    elif path.suffix in [".py",".txt",".rst"]:
        data=path.read_bytes()
        if re.search(rb"SPDX-License-Identifier|Permission is hereby granted|Redistribution and use|Licensed under|Copyright.*(?:reserved|permission)",data,re.I):
            include(relative,data)
    if path.suffix == ".whl": wheel_notices(path,relative)
output.mkdir(parents=True,exist_ok=True)
(output/"python.NOTICES.txt").write_text("\n".join(sections))
(output/"python-licenses.json").write_text(json.dumps({"source":"5e58eaad7c58df58dfa8ea549c87996e01dd1077","scope":"Full initial Lib, embedded notices and every bundled wheel, including test wheels. Embedded notices also remain in the unmodified payload.","files":records},indent=2)+"\n")
`,
      source,
      output,
    ],
    { stdio: "inherit" },
  );
}
