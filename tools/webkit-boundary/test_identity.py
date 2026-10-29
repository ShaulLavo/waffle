from pathlib import Path
import tempfile
import unittest

from identity import image_assignments, library_paths, optional_image_data


class IdentityTests(unittest.TestCase):
    def test_provenance_extracts_only_image_assignments(self):
        text = 'export ImageOS="ubuntu24"\nImageVersion=20261026.354.1\nPRIVATE_TOKEN=hidden\n'
        self.assertEqual(image_assignments(text), {'ImageOS': 'ubuntu24', 'ImageVersion': '20261026.354.1'})

    def test_ldd_extracts_actual_resolved_paths(self):
        text = 'libc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x123)\n\t/lib64/ld-linux-x86-64.so.2 (0x456)\nlinux-vdso.so.1 (0x789)\n'
        self.assertEqual(library_paths(text), {'/lib/x86_64-linux-gnu/libc.so.6', '/lib64/ld-linux-x86-64.so.2'})

    def test_optional_metadata_does_not_block_browser_prerequisites(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'metadata'
            self.assertEqual(optional_image_data(path), {})
            path.write_text('[]')
            self.assertEqual(optional_image_data(path), {})
            path.write_text('{"ImageVersion":"observed"}')
            self.assertEqual(optional_image_data(path), {'ImageVersion': 'observed'})


if __name__ == '__main__':
    unittest.main()
