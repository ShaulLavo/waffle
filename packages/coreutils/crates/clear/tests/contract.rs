use std::process::{Command, Output, Stdio};

const DEFAULT: &[u8] = b"\x1b[H\x1b[2J\x1b[3J";
const KEEP_SCROLLBACK: &[u8] = b"\x1b[H\x1b[2J";

fn command(args: &[&str], term: Option<&str>) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_clear"));
    command.args(args).env_clear().stdin(Stdio::null());
    if let Some(term) = term {
        command.env("TERM", term);
    }
    command
}

fn assert_success(output: Output, expected: &[u8]) {
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    assert_eq!(output.stdout, expected);
    assert!(output.stderr.is_empty(), "{output:?}");
}

fn assert_failure(output: Output, diagnostic: &str) {
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(output.stdout.is_empty(), "{output:?}");
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.starts_with("clear: "), "{stderr:?}");
    assert!(stderr.contains(diagnostic), "{stderr:?}");
}

#[test]
fn supported_profiles_and_repeated_x_have_exact_bytes() {
    let cases: &[(&[&str], &[u8])] = &[
        (&[], DEFAULT),
        (&["--"], DEFAULT),
        (&["-x", "-x"], KEEP_SCROLLBACK),
        (&["-x", "--"], KEEP_SCROLLBACK),
        (&["-x", "-T", "xterm", "-x"], KEEP_SCROLLBACK),
        (&["-T", "xterm", "-x"], KEEP_SCROLLBACK),
    ];
    for term in ["xterm", "xterm-256color", "xterm-ghostty"] {
        for (args, expected) in cases {
            assert_success(command(args, Some(term)).output().unwrap(), expected);
        }
    }
}

#[test]
fn last_t_overrides_environment_and_earlier_terminal_values() {
    let cases: &[&[&str]] = &[
        &["-T", "xterm"],
        &["-T", "waffle-no-such-terminal", "-T", "xterm-256color"],
        &["-T", "", "-T", "xterm-ghostty"],
        &["-T", "xterm", "-T", "xterm", "--"],
    ];
    for term in [None, Some(""), Some("waffle-no-such-terminal")] {
        for args in cases {
            assert_success(command(args, term).output().unwrap(), DEFAULT);
        }
    }
}

#[test]
fn invalid_terminals_never_emit_clear_bytes() {
    for (term, diagnostic) in [
        (None, "TERM is not set"),
        (Some(""), "unsupported terminal"),
        (Some("waffle-no-such-terminal"), "unsupported terminal"),
    ] {
        assert_failure(command(&[], term).output().unwrap(), diagnostic);
    }
}

#[test]
fn final_t_must_be_a_supported_terminal_name() {
    let cases: &[&[&str]] = &[
        &["-T", "xterm", "-T", "waffle-no-such-terminal"],
        &["-T", "xterm", "-T", ""],
        &["-T", "-x"],
        &["-T", "--"],
    ];
    for args in cases {
        assert_failure(
            command(args, Some("xterm")).output().unwrap(),
            "unsupported terminal",
        );
    }
}

#[test]
fn malformed_or_unsupported_arguments_fail_before_output() {
    let cases: &[(&[&str], &str)] = &[
        (&["-x", "-T"], "requires a terminal name"),
        (&["-T", "xterm", "-T"], "requires a terminal name"),
        (&["-T", "xterm", "-bad"], "usage:"),
        (&["--", "-x"], "usage:"),
        (&["--", "--"], "usage:"),
        (&["-xx"], "usage:"),
        (&["-xT", "xterm"], "usage:"),
        (&["-Txterm"], "usage:"),
        (&["-V"], "usage:"),
        (&["--help"], "usage:"),
        (&["--version"], "usage:"),
        (&["-"], "usage:"),
        (&[""], "usage:"),
    ];
    for (args, diagnostic) in cases {
        assert_failure(command(args, Some("xterm")).output().unwrap(), diagnostic);
    }
}

#[cfg(target_os = "linux")]
#[test]
fn stdout_write_failure_is_reported() {
    let sink = std::fs::OpenOptions::new()
        .write(true)
        .open("/dev/full")
        .unwrap();
    let output = command(&[], Some("xterm")).stdout(sink).output().unwrap();
    assert_failure(output, "write failed:");
}

#[cfg(unix)]
#[test]
fn non_unicode_input_is_rejected_or_overridden_before_output() {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;

    let invalid = OsString::from_vec(vec![0xff]);
    assert_failure(
        command(&[], None).env("TERM", &invalid).output().unwrap(),
        "unsupported terminal",
    );
    assert_failure(
        command(&[], Some("xterm")).arg(&invalid).output().unwrap(),
        "usage:",
    );
    assert_failure(
        command(&["-T"], Some("xterm"))
            .arg(&invalid)
            .output()
            .unwrap(),
        "unsupported terminal",
    );
    assert_success(
        command(&["-T", "xterm"], None)
            .env("TERM", invalid)
            .output()
            .unwrap(),
        DEFAULT,
    );
}

#[cfg(unix)]
fn closed_stdout(args: &[&str], term: &str) -> Output {
    Command::new("/bin/sh")
        .args(["-c", "exec \"$@\" 1>&-", "clear-contract"])
        .arg(env!("CARGO_BIN_EXE_clear"))
        .args(args)
        .env_clear()
        .env("TERM", term)
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

#[cfg(unix)]
#[test]
fn closed_stdout_preserves_validation_and_native_status() {
    assert_success(closed_stdout(&[], "xterm"), b"");
    assert_success(closed_stdout(&["-x"], "xterm"), b"");
    assert_failure(
        closed_stdout(&[], "waffle-no-such-terminal"),
        "unsupported terminal",
    );
    assert_failure(closed_stdout(&["-bad"], "xterm"), "usage:");
}
