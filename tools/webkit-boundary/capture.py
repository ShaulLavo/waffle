"""One storage-lock run. Keep root socket calls and the first failure's protocol window."""

import collections
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import threading
import time


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


class BoundedFile:
    def __init__(self, path, limit):
        self.file = path.open("w")
        self.limit = limit
        self.bytes = 0
        self.dropped = 0

    def append(self, text):
        size = len(text.encode())
        if self.bytes + size > self.limit:
            self.dropped += size
            return
        self.file.write(text)
        self.file.flush()
        self.bytes += size

    def close(self):
        self.file.close()


class ProtocolWindow:
    def __init__(self, limit):
        self.limit = limit
        self.lines = collections.deque()
        self.bytes = 0
        self.evicted = 0

    def append(self, text):
        if len(text) > 16384:
            text = text[:2048] + " [expression omitted sha256=" + hashlib.sha256(text.encode()).hexdigest() + "]\n"
        self.lines.append(text)
        self.bytes += len(text.encode())
        while self.bytes > self.limit:
            self.bytes -= len(self.lines.popleft().encode())
            self.evicted += 1


class JoinedCalls:
    def __init__(self):
        self.pending = {}

    def consume(self, line):
        match = re.match(r"(\d+) (\d+\.\d+) (.*)", line)
        if not match:
            return line
        pid, timestamp, body = match.groups()
        if "<unfinished ...>" in body:
            self.pending[pid] = (timestamp, body.replace("<unfinished ...>", ""))
            return ""
        resumed = re.match(r"<\.\.\. (\w+) resumed>(.*)", body)
        if not resumed or pid not in self.pending:
            return line
        start, first = self.pending.pop(pid)
        return f"{pid} {start} {first}{resumed[2]}\n"


def process_record(pid):
    root = Path(f"/proc/{pid}")
    try:
        names = ["stat", "status", "wchan"]
        result = {name: (root / name).read_text() for name in names}
        result["cmdline"] = (root / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
        descriptors = list((root / "fd").iterdir())
        result["descriptorCount"] = len(descriptors)
        result["descriptors"] = {p.name: os.readlink(p) for p in descriptors[:128]}
        return result
    except (FileNotFoundError, ProcessLookupError, PermissionError, OSError) as error:
        return {"unavailable": str(error)}


class Capture:
    def __init__(self, directory):
        self.directory = directory
        self.protocol = ProtocolWindow(2 * 1024 * 1024)
        self.transport = BoundedFile(directory / "root-sockets.strace", 4 * 1024 * 1024)
        self.processes = BoundedFile(directory / "processes.strace", 1024 * 1024)
        self.stdout = BoundedFile(directory / "runner.stdout", 256 * 1024)
        self.stderr = BoundedFile(directory / "runner.stderr", 512 * 1024)
        self.calls = JoinedCalls()
        self.root_flows = set()
        self.owned = set()
        self.failure = None
        self.target_case_passed = False
        self.library_paths = set()
        self.initial_maps = False
        self.freeze_at = float("inf")
        self.errors = []

    def fail(self, line):
        if self.failure is not None:
            return
        self.failure = {"line": line.strip(), "wallClock": time.time()}
        self.freeze_at = time.monotonic() + 1
        write_json(self.directory / "first-failure.json", self.failure)
        write_json(self.directory / "failure-processes.json", {str(pid): process_record(pid) for pid in tuple(self.owned)})
        self.sample_mappings("failure-mappings.json")

    def sample_mappings(self, name):
        mappings = {}
        for pid in tuple(self.owned):
            try:
                text = Path(f"/proc/{pid}/maps").read_text()
                self.library_paths.update(re.findall(r"^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(/[^\n]+)", text, re.M))
                mappings[str(pid)] = text[:65536]
            except OSError:
                continue
        write_json(self.directory / name, mappings)

    def syscall(self, raw):
        line = self.calls.consume(raw)
        match = re.match(r"(\d+) ", line)
        if not match:
            return
        pid = int(match[1])
        if "execve(" in line:
            self.owned.add(pid)
            self.processes.append(line)
        if "+++ exited" in line or "+++ killed" in line:
            self.record_exit(pid, line)
        if time.monotonic() > self.freeze_at:
            return
        self.socket(line)

    def record_exit(self, pid, line):
        if pid not in self.owned:
            return
        self.processes.append(line)
        self.owned.remove(pid)

    def socket(self, line):
        peer = re.search(r"TCP:\[127\.0\.0\.1:(\d+)->127\.0\.0\.1:(\d+)\]", line)
        if not peer:
            return
        flow = tuple(sorted((int(peer[1]), int(peer[2]))))
        request = re.search(r'"GET (\S+) HTTP/1\.1', line)
        if request and request[1] in ("/", "/blank"):
            self.root_flows.add(flow)
            if not self.initial_maps:
                self.initial_maps = True
                self.sample_mappings("initial-mappings.json")
        elif request:
            self.root_flows.discard(flow)
        if flow in self.root_flows:
            self.transport.append(line)

    def output(self, name, line):
        if "pw:protocol" in line:
            self.protocol_line(line)
            return
        getattr(self, name).append(line)
        if "PASS webkit indexeddb: ownership loss after gated recovery retains failed cleanup owner" in line:
            self.target_case_passed = True
        if "FAIL webkit " in line or '"phase":"navigation"' in line or '"phase":"new-page"' in line:
            self.fail(line)
        if name == "stdout" or "FAIL webkit " in line:
            print(line.rstrip(), flush=True)

    def protocol_line(self, line):
        if time.monotonic() > self.freeze_at:
            return
        relevant = r"Page\.(navigate|frameNavigated|loadEventFired|domContentEventFired)|Network\.(requestWillBeSent|responseReceived|loadingFailed|loadingFinished)|Target\.(targetCreated|targetDestroyed|didCommitProvisionalTarget)|Playwright\.(createContext|deleteContext|createPage|close)|Runtime\.(evaluate|callFunctionOn)"
        if re.search(relevant, line):
            self.protocol.append(line)

    def finish(self, status, scratch_before, scratch_root):
        for pid, (timestamp, body) in self.calls.pending.items():
            self.socket(f"{pid} {timestamp} {body}<unfinished ...>\n")
        for file in (self.transport, self.processes, self.stdout, self.stderr):
            file.close()
        (self.directory / "protocol-window.log").write_text("".join(self.protocol.lines))
        write_json(self.directory / "mapped-files.json", sorted(self.library_paths))
        live = {str(pid): process_record(pid) for pid in self.owned if Path(f"/proc/{pid}").exists()}
        scratch_after = {p.name for p in scratch_root.glob("wb-*")}
        receipt = {"suiteExit": status, "failure": self.failure, "collectorErrors": self.errors,
                   "targetCasePassed": self.target_case_passed,
                   "droppedBytes": {name: getattr(self, name).dropped for name in ("transport", "processes", "stdout", "stderr")},
                   "protocolEvictedLines": self.protocol.evicted, "liveTracedProcesses": live,
                   "newSupervisorScratchRemaining": sorted(scratch_after - scratch_before),
                   "unfinishedCalls": len(self.calls.pending), "protocolFreeze": "one second after first reported case failure, otherwise terminal tail"}
        receipt["classification"] = "CAPTURED_FAILURE" if self.failure else "NONREPRODUCTION"
        invalid_nonreproduction = self.failure is None and (status != 0 or not self.transport.bytes or not self.target_case_passed)
        if live or any(receipt["droppedBytes"].values()) or self.errors or scratch_after - scratch_before or invalid_nonreproduction:
            receipt["classification"] = "INCOMPLETE_CAPTURE"
        write_json(self.directory / "result.json", receipt)
        return receipt


def consume(stream, action, errors):
    try:
        for line in stream:
            action(line)
    except Exception as error:
        errors.append(repr(error))


def consume_fifo(path, capture):
    with path.open() as stream:
        consume(stream, capture.syscall, capture.errors)


def main():
    directory, source = (Path(arg).resolve() for arg in sys.argv[1:])
    directory.mkdir(parents=True, exist_ok=False)
    capture = Capture(directory)
    scratch_root = Path(os.environ["RUNNER_TEMP"])
    scratch_before = {p.name for p in scratch_root.glob("wb-*")}
    fifo = directory / "syscalls.fifo"
    os.mkfifo(fifo)
    command = ["bun", "scripts/browser-supervisor.ts", "65000", "strace", "--kill-on-exit", "-f", "-ttt", "-T", "-yy", "-s", "512", "-e", "trace=%network,%process,read,readv,write,writev,close", "-o", str(fifo), "bun", "tests/storage-lock-browser-runner.ts", "webkit"]
    env = dict(os.environ, DEBUG="pw:browser,pw:protocol", DEBUG_COLORS="0", STORAGE_LOCK_TRACE="1", STORAGE_SCRATCH_ROOT=str(scratch_root), PROCESS_SCRATCH_ROOT=str(scratch_root))
    env.pop("STORAGE_LOCK_TEST_FILTER", None)
    write_json(directory / "ownership.json", {"command": command, "source": str(source), "scratchBorrowed": str(scratch_root), "owned": ["supervised browser tree", str(fifo), "bounded evidence files"], "memoryBefore": Path("/proc/meminfo").read_text(), "processesBefore": subprocess.check_output(["ps", "-eo", "pid,ppid,stat,comm"], text=True)})
    process = None
    threads = []
    status = 1
    def stop(signum, frame):
        if process is not None:
            os.killpg(process.pid, signal.SIGTERM)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        process = subprocess.Popen(command, cwd=source / "packages/waffle", env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        threads = [threading.Thread(target=consume_fifo, args=(fifo, capture), daemon=True)]
        threads += [threading.Thread(target=consume, args=(stream, lambda line, name=name: capture.output(name, line), capture.errors), daemon=True) for name, stream in (("stdout", process.stdout), ("stderr", process.stderr))]
        for thread in threads:
            thread.start()
        status = process.wait(timeout=680)
    finally:
        if process is not None and process.poll() is None:
            stop(None, None)
            status = process.wait(timeout=75)
        for thread in threads:
            thread.join(timeout=5)
        if any(thread.is_alive() for thread in threads):
            capture.errors.append("Capture reader did not join")
        fifo.unlink()
    result = capture.finish(status, scratch_before, scratch_root)
    print(json.dumps(result), flush=True)
    return 1 if result["classification"] == "INCOMPLETE_CAPTURE" else status


if __name__ == "__main__":
    sys.exit(main())
