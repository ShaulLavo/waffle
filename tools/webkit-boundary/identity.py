"""Record image-metadata provenance and the binaries/libraries actually available to the run."""

import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def command(args, env=None):
    result = subprocess.run(args, text=True, capture_output=True, env=env)
    return {"command": args, "status": result.returncode, "stdout": result.stdout, "stderr": result.stderr}


def image_assignments(text):
    return dict(re.findall(r"\b(ImageOS|ImageVersion)\s*=\s*[\"']?([A-Za-z0-9._/-]+)", text))


def setup_info_paths():
    paths = set(Path("/home/runner/runners").glob("*/.setup_info"))
    pid = os.getppid()
    for _ in range(8):
        try:
            executable = Path(os.readlink(f"/proc/{pid}/exe"))
            paths.add(executable.parent.parent / ".setup_info")
            status = Path(f"/proc/{pid}/status").read_text()
            pid = int(re.search(r"^PPid:\s+(\d+)", status, re.M)[1])
        except (OSError, TypeError):
            break
    return sorted(paths)


def public_setup_info(path):
    try:
        rows = json.loads(path.read_text())
        rows = [{"group": row.get("Group", row.get("group")), "detail": row.get("Detail", row.get("detail"))} for row in rows]
        rows = [row for row in rows if row["group"] in ("Runner Image", "Operating System", "Runner Image Provisioner")]
        return {"path": str(path), "sha256": digest(path), "publicGroups": rows}
    except (OSError, ValueError, AttributeError):
        return {"path": str(path), "unavailable": True}


def optional_assignments(path):
    try:
        return image_assignments(path.read_text(errors="replace"))
    except OSError:
        return {}


def optional_image_data(path):
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def platform_identity(output):
    release = platform.freedesktop_os_release()
    assert release["ID"] == "ubuntu" and release["VERSION_ID"] == "24.04", release
    assert platform.machine() == "x86_64", platform.machine()
    files = [Path("/etc/environment")]
    files += list(Path("/etc/profile.d").glob("*.sh"))
    assignments = {}
    for path in files:
        values = optional_assignments(path)
        if values:
            assignments[str(path)] = values
    image_data = Path("/imagegeneration/imagedata.json")
    data = optional_image_data(image_data)
    image_fields = {key: value for key, value in data.items() if re.search(r"image.*(version|os)|os.*version", key, re.I)}
    value = {"osRelease": release, "uname": list(platform.uname()),
             "shellEnvironment": {name: os.environ.get(name) for name in ("ImageOS", "ImageVersion", "RUNNER_OS", "RUNNER_ARCH")},
             "imageAssignments": assignments, "imageGenerationFields": image_fields,
             "runnerSetupInfo": [public_setup_info(path) for path in setup_info_paths()],
             "originalFailureSetupBannerVersion": "20261025.353.1",
             "qualification": "Ubuntu 24.04/x86_64 and exact tool inputs are asserted. Image patch metadata is recorded, not equated. Original runtime binary/library identities were not captured, so byte-identical VM provenance is not claimed.",
             "bannerProvenance": "actions/runner v2.338.0 JobExtension.cs reads public groups from root/.setup_info; shell ImageVersion is separate environment data."}
    output.write_text(json.dumps(value, indent=2) + "\n")
    print(json.dumps(value), flush=True)


def library_paths(text):
    return set(re.findall(r"(?:=>\s+|^\s*)(/[^\s]+)", text, re.M))


def file_identity(path):
    try:
        target = path.resolve(strict=True)
        return {"path": str(path), "realPath": str(target), "bytes": target.stat().st_size, "sha256": digest(target)}
    except OSError as error:
        return {"path": str(path), "unavailable": str(error)}


def runtime_identity(output, source, report):
    manifest = source / "packages/waffle/node_modules/playwright-core/browsers.json"
    playwright = source / "packages/waffle/node_modules/playwright/package.json"
    browser = next(row for row in json.loads(manifest.read_text())["browsers"] if row["name"] == "webkit")
    assert json.loads(playwright.read_text())["version"] == "1.64.1"
    assert browser["revision"] == "2370"
    bun = Path(shutil.which("bun"))
    assert command([str(bun), "--version"])["stdout"].strip() == "1.4.4"
    cache = Path(os.environ.get("PLAYWRIGHT_BROWSERS_PATH", str(Path.home() / ".cache/ms-playwright")))
    webkit = cache / "webkit-2370/minibrowser-wpe"
    binaries = [bun]
    binaries += [path for path in (webkit / "bin").iterdir() if path.is_file() and os.access(path, os.X_OK)]
    env = dict(os.environ, LD_LIBRARY_PATH=f"{webkit}/lib:{webkit}/sys/lib")
    libraries = set()
    links = []
    for binary in binaries:
        result = command(["ldd", str(binary)], env)
        assert "not found" not in result["stdout"], result
        libraries.update(library_paths(result["stdout"]))
        links.append(result)
    mapped = report / "mapped-files.json"
    if mapped.exists():
        libraries.update(Path(path) for path in json.loads(mapped.read_text()))
    libraries = {Path(path) for path in libraries if Path(path).is_file()}
    names = ["bun.lock", "packages/waffle/tests/storage-lock-browser-runner.ts", "packages/waffle/tests/storage-lock-browser.ts", "packages/waffle/tests/storage-lock-recovery-worker.ts", "packages/waffle/tests/fixtures/storage-lock-startup.ts", "packages/waffle/scripts/browser-supervisor.ts"]
    inventory = command(["dpkg-query", "-W", "-f=${binary:Package}\t${Version}\t${Architecture}\n"])
    (output.parent / "installed-packages.tsv").write_text(inventory["stdout"])
    value = {"source": command(["git", "-C", str(source), "rev-parse", "HEAD"]),
             "sourceStatus": command(["git", "-C", str(source), "status", "--porcelain=v1"]),
             "bun": file_identity(bun), "playwrightVersion": "1.64.1", "webkitRevision": "2370",
             "libc": command(["getconf", "GNU_LIBC_VERSION"]), "lddVersion": command(["ldd", "--version"]),
             "strace": command(["strace", "--version"]), "browserBinaries": [file_identity(path) for path in binaries],
             "dynamicDependencies": links, "libraryFiles": [file_identity(path) for path in sorted(libraries)],
             "sourceFiles": [file_identity(source / name) for name in names],
             "browserManifest": file_identity(manifest), "playwrightPackage": file_identity(playwright),
             "installedPackages": {"status": inventory["status"], "sha256": digest(output.parent / "installed-packages.tsv")}}
    output.write_text(json.dumps(value, indent=2) + "\n")


if __name__ == "__main__":
    mode, output, *args = sys.argv[1:]
    if mode == "platform":
        platform_identity(Path(output))
    elif mode == "runtime":
        runtime_identity(Path(output), Path(args[0]), Path(args[1]))
    else:
        raise ValueError("Unknown identity mode")
