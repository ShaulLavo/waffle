#![cfg(not(target_os = "wasi"))]

#[path = "process.rs"]
mod process;

#[test]
fn upstream_head_counts_lines_bytes_and_binary_data() {
    for (args, input, expected) in [
        (vec!["-n2"], &b"one\ntwo\nthree"[..], &b"one\ntwo\n"[..]),
        (vec!["--bytes=3"], &b"\xff\0abc\n"[..], &b"\xff\0a"[..]),
        (vec!["-1"], &b"one\ntwo\n"[..], &b"one\n"[..]),
        (
            vec!["-n", "-1"],
            &b"one\ntwo\nthree"[..],
            &b"one\ntwo\n"[..],
        ),
        (vec!["-c", "-2"], &b"abcdef"[..], &b"abcd"[..]),
        (vec!["-z", "-n1"], &b"one\0two\0"[..], &b"one\0"[..]),
        (vec!["-c", "1KB"], &b"abc"[..], &b"abc"[..]),
    ] {
        let output = process::run(env!("CARGO_BIN_EXE_head"), &args, input, false);
        assert!(output.status.success(), "{args:?}: {output:?}");
        assert_eq!(output.stdout, expected, "{args:?}");
        assert!(output.stderr.is_empty(), "{args:?}: {output:?}");
    }
}

#[test]
fn upstream_head_reports_real_argument_errors() {
    for args in [
        vec!["-n"],
        vec!["--lines=oops"],
        vec!["-c", "1J"],
        vec!["--not-an-option"],
    ] {
        let output = process::run(env!("CARGO_BIN_EXE_head"), &args, b"", false);
        assert_eq!(output.status.code(), Some(1), "{args:?}");
        assert!(output.stdout.is_empty());
        assert!(!output.stderr.is_empty());
    }
}

#[test]
fn upstream_head_exposes_help_and_version() {
    let help = process::run(env!("CARGO_BIN_EXE_head"), &["--help"], b"", false);
    assert!(help.status.success());
    assert!(String::from_utf8_lossy(&help.stdout).contains("--lines"));
    let version = process::run(env!("CARGO_BIN_EXE_head"), &["--version"], b"", false);
    assert!(version.status.success());
    assert!(String::from_utf8_lossy(&version.stdout).contains("0.12.0"));
}
