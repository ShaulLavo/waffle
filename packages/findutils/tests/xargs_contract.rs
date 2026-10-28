#![cfg(not(target_os = "wasi"))]

#[path = "process.rs"]
mod process;

fn xargs(args: &[&str], input: &[u8]) -> std::process::Output {
    process::run(env!("CARGO_BIN_EXE_xargs"), args, input, true)
}

fn assert_rejected(args: &[&str], input: &[u8], expected_stderr: Option<&str>) {
    let result = xargs(args, input);
    assert_eq!(result.status.code(), Some(1), "{args:?}: {result:?}");
    assert!(result.stdout.is_empty());
    assert!(!result.stderr.is_empty());
    if let Some(expected) = expected_stderr {
        assert!(String::from_utf8_lossy(&result.stderr).contains(expected));
    }
}

#[test]
fn parses_input_and_batches_internal_echo() {
    for (args, input, expected) in [
        (vec![], &b"one two\nthree\n"[..], &b"one two three\n"[..]),
        (vec!["-n2"], &b"a b c d e"[..], &b"a b\nc d\ne\n"[..]),
        (
            vec![],
            &b"'two words' a\\ b \"c d\"\n"[..],
            &b"two words a b c d\n"[..],
        ),
        (
            vec!["-0", "-n1"],
            &b"a b\0'quoted'\0c\\d\0"[..],
            &b"a b\n'quoted'\nc\\d\n"[..],
        ),
        (vec!["-d", ":", "-n2"], &b"a b:c:d"[..], &b"a b c\nd\n"[..]),
        (vec!["-L1"], &b"a b\nc d\n"[..], &b"a b\nc d\n"[..]),
        (vec!["-s9"], &b"a b c"[..], &b"a b\nc\n"[..]),
        (vec!["-E", "STOP"], &b"a STOP b\n"[..], &b"a\n"[..]),
        (vec![], &b""[..], &b"\n"[..]),
        (vec!["-r"], &b" \t\n"[..], &b""[..]),
    ] {
        let result = xargs(&args, input);
        assert_eq!(result.status.code(), Some(0), "{args:?}: {result:?}");
        assert_eq!(result.stdout, expected, "{args:?}");
        assert!(result.stderr.is_empty(), "{args:?}: {result:?}");
    }
}

#[test]
fn rejects_invalid_input_and_unsupported_modes() {
    for args in [
        vec!["-n0"],
        vec!["-P2"],
        vec!["-P1", "echo"],
        vec!["-I{}", "echo", "{}"],
        vec!["-I{}"],
        vec!["--replace"],
        vec!["--bad"],
    ] {
        assert_rejected(&args, b"", None);
    }
    assert_rejected(&[], b"'unterminated", None);
}

#[test]
fn help_names_unsupported_modes_and_version_retains_upstream_identity() {
    let help = xargs(&["--help"], b"");
    assert_eq!(help.status.code(), Some(0));
    assert!(
        String::from_utf8_lossy(&help.stdout)
            .contains("replacement and parallel execution are unsupported")
    );
    let version = xargs(&["--version"], b"");
    assert_eq!(version.status.code(), Some(0));
    assert_eq!(version.stdout, b"xargs 0.11.0\n");
}

#[test]
fn explicit_commands_match_gnu_with_controlled_executables() {
    use std::process::Command;
    let scratch = tempfile::Builder::new()
        .prefix("xargs-explicit-")
        .tempdir()
        .unwrap();
    let child = scratch.path().join("child");
    assert!(
        Command::new("cc")
            .args(["tests/fixtures/xargs-child.c", "-o"])
            .arg(&child)
            .status()
            .unwrap()
            .success()
    );
    let child = child.to_str().unwrap();
    let cases: Vec<(Vec<&str>, &[u8])> = vec![
        (
            vec![child, "dump", "fixed space", "'literal'"],
            b"'two words' a\\ b \"c d\"\n",
        ),
        (vec!["-0", "-n2", child, "dump"], b"a b\0'quoted'\0c\\d\0\0"),
        (vec!["-n1", child, "dump"], b"a b c\n"),
        (vec!["-L1", child, "dump"], b"a b\nc d\n"),
        (vec!["-d:", "-n2", child, "dump"], b"a b:c:d"),
        (vec![child, "dump"], b""),
        (vec![child, "dump"], b"\"\""),
        (vec!["-r", child, "dump"], b" \t\n"),
        (vec![child, "stdin"], b"ignored\n"),
        (vec![child, "status", "7"], b"a\n"),
        (vec![child, "status", "126"], b"a\n"),
        (vec![child, "status", "127"], b"a\n"),
        (vec!["-n1", child, "sequence"], b"255 0"),
        (vec!["-n1", child, "sequence"], b"1 0"),
        (vec![child, "signal", "15"], b"a"),
        (vec!["/missing-xargs-controlled-command"], b"a"),
        (vec!["-r", "/missing-xargs-controlled-command"], b""),
    ];
    for (args, input) in cases {
        let actual = xargs(&args, input);
        let expected = process::run("/usr/bin/xargs", &args, input, true);
        assert_eq!(
            actual.status.code(),
            expected.status.code(),
            "{args:?}: {actual:?}"
        );
        assert_eq!(actual.stdout, expected.stdout, "{args:?}");
        assert_eq!(
            actual.stderr.is_empty(),
            expected.stderr.is_empty(),
            "{args:?}"
        );
    }
    let plain = scratch.path().join("plain");
    std::fs::write(&plain, b"not executable").unwrap();
    let result = xargs(&[plain.to_str().unwrap()], b"a");
    assert_eq!(result.status.code(), Some(126));
}
