use std::fs;
use std::path::PathBuf;
use std::process::Command;

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.build")
            .join(format!("native-find-{}", std::process::id()));
        let fixture = Self(path);
        fs::create_dir_all(&fixture.0).unwrap();
        fs::write(fixture.0.join("first"), "one").unwrap();
        fs::write(fixture.0.join("last"), "two").unwrap();
        fixture
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn nul_starting_paths_report_errors_without_discarding_valid_records() {
    let fixture = Fixture::new();
    for bytes in [
        b"first\0\0last\0".as_slice(),
        b"\0first\0last\0",
        b"first\0last\0\0",
    ] {
        fs::write(fixture.0.join("roots"), bytes).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_find"))
            .args(["-files0-from", "roots", "-print0"])
            .current_dir(&fixture.0)
            .env("PWD", &fixture.0)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(1));
        assert_eq!(output.stdout, b"first\0last\0");
        assert!(
            String::from_utf8(output.stderr)
                .unwrap()
                .contains("invalid zero-length file name")
        );
    }
}
