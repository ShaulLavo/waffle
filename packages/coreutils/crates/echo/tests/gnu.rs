#![cfg(not(target_os = "wasi"))]

use std::process::{Command, Output};

fn run(binary: &str, args: &[&str], posix: bool) -> Output {
    let mut command = Command::new(binary);
    command.args(args).env_clear().env("LC_ALL", "C");
    if posix {
        command.env("POSIXLY_CORRECT", "1");
    }
    command.output().unwrap()
}

#[test]
fn exact_gnu_output_for_flags_escapes_empty_unicode_and_control_bytes() {
    let cases: Vec<Vec<&str>> = vec![
        vec![],
        vec![""],
        vec!["one", "two words", "", "three"],
        vec!["-n", "X"],
        vec!["-ne", "a\\nb\\tend"],
        vec!["-e", "\\a\\b\\e\\f\\n\\r\\t\\v\\\\"],
        vec!["-e", "\\0\\001\\0177\\0377\\x00\\x41\\xFF"],
        vec!["-e", "before\\cafter", "ignored"],
        vec!["-e", "\\q\\xZ\\08"],
        vec!["-e", "-E", "a\\nb"],
        vec!["-E", "-e", "a\\nb"],
        vec!["-nEe", "text"],
        vec!["--", "X"],
        vec!["-bad", "X"],
        vec!["X", "-n"],
        vec!["--help", "literal"],
        vec!["--version", "literal"],
        vec!["שלום", "🌍", "é"],
        vec!["\u{1}\t\r", "\u{7}"],
    ];
    for posix in [false, true] {
        for args in &cases {
            let expected = run("/usr/bin/echo", args, posix);
            let actual = run(env!("CARGO_BIN_EXE_echo"), args, posix);
            assert_eq!(
                actual.status.code(),
                expected.status.code(),
                "{args:?}, POSIX={posix}"
            );
            assert_eq!(actual.stdout, expected.stdout, "{args:?}, POSIX={posix}");
            assert_eq!(actual.stderr, expected.stderr, "{args:?}, POSIX={posix}");
        }
    }
}

#[test]
fn output_failure_returns_gnu_failure_status() {
    use std::fs::OpenOptions;
    let expected = Command::new("/usr/bin/echo")
        .arg("X")
        .env_clear()
        .stdout(OpenOptions::new().write(true).open("/dev/full").unwrap())
        .output()
        .unwrap();
    let actual = Command::new(env!("CARGO_BIN_EXE_echo"))
        .arg("X")
        .env_clear()
        .stdout(OpenOptions::new().write(true).open("/dev/full").unwrap())
        .output()
        .unwrap();
    assert_eq!(expected.status.code(), Some(1));
    assert_eq!(actual.status.code(), expected.status.code());
    assert!(!actual.stderr.is_empty());
}
