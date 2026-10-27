#![cfg(not(target_os = "wasi"))]

use std::{
    io::Write,
    process::{Command, Output, Stdio},
};

fn run(binary: &str, args: &[&str], input: &[u8]) -> Output {
    let mut command = Command::new(binary);
    command.env("LC_ALL", "C").env("PATH", "").args(args);
    command.stdin(Stdio::piped());
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut process = command.spawn().expect("start upstream utility");
    let mut stdin = process.stdin.take().expect("piped stdin");
    stdin.write_all(input).expect("write fixture input");
    drop(stdin);
    process.wait_with_output().expect("collect utility output")
}

fn bytes(value: &serde_json::Value) -> Vec<u8> {
    value
        .as_array()
        .expect("frozen bytes")
        .iter()
        .map(|byte| u8::try_from(byte.as_u64().expect("unsigned byte")).expect("byte range"))
        .collect()
}

#[test]
fn upstream_programs_match_frozen_gnu_output_and_status() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../fixtures/sort-uniq.json"))
            .expect("frozen GNU observations");
    let mut checked = 0;
    for entry in fixture["cases"].as_array().expect("frozen cases") {
        let Some(native) = entry.get("native") else {
            continue;
        };
        let binary = match native["program"].as_str().expect("program") {
            "sort" => env!("CARGO_BIN_EXE_sort"),
            "uniq" => env!("CARGO_BIN_EXE_uniq"),
            name => panic!("unrecorded native program {name}"),
        };
        let args: Vec<_> = native["args"]
            .as_array()
            .expect("frozen arguments")
            .iter()
            .map(|arg| arg.as_str().expect("argument"))
            .collect();
        let actual = run(binary, &args, &bytes(&native["stdin"]));
        assert_eq!(
            actual.status.code(),
            Some(i32::try_from(entry["status"].as_i64().expect("status")).expect("status range"))
        );
        assert_eq!(actual.stdout, bytes(&entry["stdout"]), "{entry}");
        assert_eq!(
            !actual.stderr.is_empty(),
            entry["stderrPresent"].as_bool().expect("stderr presence")
        );
        checked += 1;
    }
    assert_eq!(checked, 14, "native frozen-case coverage changed");
}

#[test]
fn upstream_programs_keep_argument_errors_and_version() {
    for binary in [env!("CARGO_BIN_EXE_sort"), env!("CARGO_BIN_EXE_uniq")] {
        let error = run(binary, &["--not-an-option"], b"");
        assert!(!error.status.success());
        assert!(!error.stderr.is_empty());
        let version = run(binary, &["--version"], b"");
        assert!(version.status.success());
        assert!(String::from_utf8_lossy(&version.stdout).contains("0.12.0"));
    }
}
