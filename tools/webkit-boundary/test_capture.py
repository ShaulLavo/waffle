import json
from pathlib import Path
import tempfile
import unittest

from capture import BoundedFile, Capture, JoinedCalls, ProtocolWindow


class CaptureTests(unittest.TestCase):
    def test_resumed_read_preserves_original_socket_identity(self):
        calls = JoinedCalls()
        first = '12 100.000 recvfrom(18<TCP:[127.0.0.1:5000->127.0.0.1:6000]>, <unfinished ...>\n'
        last = '12 100.001 <... recvfrom resumed>"HTTP/1.1 200 OK", 8192, 0, NULL, NULL) = 15 <0.001>\n'
        self.assertEqual(calls.consume(first), "")
        self.assertIn('recvfrom(18<TCP:[127.0.0.1:5000->127.0.0.1:6000]>, "HTTP/1.1', calls.consume(last))
        self.assertEqual(calls.pending, {})

    def test_root_flow_keeps_server_write_and_client_read_but_excludes_fixture(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            capture = Capture(root)
            request = '12 100.000 sendto(18<TCP:[127.0.0.1:5000->127.0.0.1:6000]>, "GET / HTTP/1.1", 14, 0, NULL, 0) = 14\n'
            write = '13 100.001 sendto(19<TCP:[127.0.0.1:6000->127.0.0.1:5000]>, "HTTP/1.1 200 OK", 15, 0, NULL, 0) = 15\n'
            read = write.replace('13 100.001 sendto(19', '12 100.002 recvfrom(18')
            for line in (request, write, read, request.replace('GET / HTTP', 'GET /fixture.js HTTP'), write):
                capture.syscall(line)
            capture.output('stdout', 'PASS webkit indexeddb: ownership loss after gated recovery retains failed cleanup owner\n')
            result = capture.finish(0, set(), root)
            self.assertEqual((root / 'root-sockets.strace').read_text(), request + write + read)
            self.assertEqual(result['classification'], 'NONREPRODUCTION')

    def test_first_failure_is_immutable_and_keeps_failing_protocol_window(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            capture = Capture(root)
            capture.output('stderr', 'pw:protocol Page.navigate first-target\n')
            capture.fail('FAIL webkit first')
            capture.fail('FAIL webkit second')
            capture.freeze_at = 0
            capture.output('stderr', 'pw:protocol Page.navigate successor\n')
            result = capture.finish(1, set(), root)
            self.assertEqual(result['classification'], 'CAPTURED_FAILURE')
            self.assertEqual(json.loads((root / 'first-failure.json').read_text())['line'], 'FAIL webkit first')
            self.assertNotIn('successor', (root / 'protocol-window.log').read_text())

    def test_overflow_is_incomplete_instead_of_nonreproduction(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            capture = Capture(root)
            capture.transport.limit = 1
            capture.transport.append('unretained evidence')
            result = capture.finish(0, set(), root)
            self.assertEqual(result['classification'], 'INCOMPLETE_CAPTURE')
            self.assertGreater(result['droppedBytes']['transport'], 0)

    def test_setup_failure_is_not_nonreproduction(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            capture = Capture(root)
            result = capture.finish(127, set(), root)
            self.assertEqual(result['classification'], 'INCOMPLETE_CAPTURE')

    def test_navigation_diagnostic_freezes_before_case_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            capture = Capture(root)
            line = '{"navigation":{"phase":"navigation","current":"blank","events":["request /"]}}\n'
            capture.output('stderr', line)
            self.assertEqual(capture.failure['line'], line.strip())
            capture.finish(1, set(), root)

    def test_process_exit_releases_only_recorded_process(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            capture = Capture(root)
            capture.syscall('999999 100.000 execve("/webkit/WebKitWebProcess", ["WebKitWebProcess"], []) = 0\n')
            capture.syscall('999998 100.001 +++ exited with 0 +++\n')
            capture.syscall('999999 100.002 +++ exited with 0 +++\n')
            self.assertEqual(capture.owned, set())
            capture.finish(0, set(), root)
            self.assertNotIn('999998', (root / 'processes.strace').read_text())

    def test_protocol_retains_tail_with_an_explicit_eviction_count(self):
        window = ProtocolWindow(12)
        for line in ('first\n', 'second\n', 'last\n'):
            window.append(line)
        self.assertEqual(''.join(window.lines), 'second\nlast\n')
        self.assertEqual(window.evicted, 1)

    def test_file_limit_counts_utf8_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'bounded'
            file = BoundedFile(path, 3)
            file.append('é')
            file.append('é')
            file.close()
            self.assertEqual(path.read_text(), 'é')
            self.assertEqual(file.dropped, 2)


if __name__ == '__main__':
    unittest.main()
