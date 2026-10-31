#![cfg(not(target_os = "wasi"))]

use std::process::{Command, Output};

fn env(args: &[&str], inherited: &[(&str, &str)]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_env"))
        .env_clear()
        .envs(inherited.iter().copied())
        .args(args)
        .output()
        .expect("run the new env candidate, not a host env program")
}

fn assert_printed_environment(args: &[&str], inherited: &[(&str, &str)], expected: &str) {
    let output = env(args, inherited);
    assert_eq!(output.status.code(), Some(0), "{args:?}: {output:?}");
    assert_eq!(output.stdout, expected.as_bytes(), "{args:?}");
    assert!(output.stderr.is_empty(), "{args:?}: {output:?}");
}

#[test]
fn print_only_source_contract_has_exact_bytes() {
    for (args, inherited, expected) in [
        (vec![], vec![("A", "old"), ("B", "keep")], "A=old\nB=keep\n"),
        (vec!["-i", "A=one", "B=two"], vec![], "A=one\nB=two\n"),
        (vec!["-i", "-0", "A=one", "B=two"], vec![], "A=one\0B=two\0"),
        (
            vec!["-u", "A"],
            vec![("A", "old"), ("B", "keep")],
            "B=keep\n",
        ),
        (
            vec!["-i", "-S", "A=one B=\"two words\""],
            vec![],
            "A=one\nB=two words\n",
        ),
        (
            vec!["-i", "-S", "A=pre${BASE}post"],
            vec![("BASE", "middle")],
            "A=premiddlepost\n",
        ),
    ] {
        assert_printed_environment(&args, &inherited, expected);
    }
}

#[test]
fn print_only_local_errors_do_not_need_a_process() {
    for args in [
        vec!["-C", "/"],
        vec!["-u", "bad=name"],
        vec!["-S", "A=one\\q"],
        vec!["-S", "A=$BASE"],
    ] {
        let output = env(&args, &[]);
        assert_eq!(output.status.code(), Some(125), "{args:?}: {output:?}");
        assert!(output.stdout.is_empty(), "{args:?}");
        assert!(!output.stderr.is_empty(), "{args:?}");
    }
}

#[test]
fn debug_printing_does_not_change_environment_output() {
    let output = env(&["-vv", "-i", "A=one"], &[("A", "old")]);
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(output.stdout, b"A=one\n");
    assert!(!output.stderr.is_empty());
}

#[test]
fn assignments_keep_order_and_values_after_unsets() {
    for (args, inherited, expected) in [
        (
            vec!["-u", "A", "-u", "MISSING", "A=first", "A=last", "C=x=y"],
            vec![("A", "old"), ("B", "keep")],
            "B=keep\nA=last\nC=x=y\n",
        ),
        (
            vec!["-", "--odd=value", "EMPTY="],
            vec![("OLD", "gone")],
            "--odd=value\nEMPTY=\n",
        ),
        (vec!["-i", "--", "-name=value"], vec![], "-name=value\n"),
        (
            vec!["-i", "-0", "A=line\nbreak", "B=two words"],
            vec![],
            "A=line\nbreak\0B=two words\0",
        ),
        (
            vec!["-i", "-S", "A=\"one\\_two\" B='${BASE}' # comment"],
            vec![("BASE", "expanded")],
            "A=one two\nB=${BASE}\n",
        ),
    ] {
        assert_printed_environment(&args, &inherited, expected);
    }
}

#[test]
fn command_operands_match_gnu_environment_and_argument_rules() {
    for args in [
        vec!["-i", "/usr/bin/env"],
        vec!["-u", "A", "A=first", "A=last", "/usr/bin/env"],
        vec!["-i", "A=x=y", "EMPTY=", "/usr/bin/env"],
        vec!["-i", "-S", "A='two words' /usr/bin/env"],
        vec!["-i", "/bin/sh", "-c", "exit 23"],
        vec!["-0", "/usr/bin/env"],
        vec!["-u", "bad=name", "/usr/bin/env"],
    ] {
        let inherited = [("A", "old"), ("B", "keep")];
        let actual = env(&args, &inherited);
        let oracle = Command::new("/usr/bin/env")
            .env_clear()
            .envs(inherited)
            .args(&args)
            .output()
            .expect("GNU env test oracle");
        assert_eq!(actual.status.code(), oracle.status.code(), "{args:?}");
        assert_eq!(actual.stdout, oracle.stdout, "{args:?}");
        assert_eq!(
            actual.stderr.is_empty(),
            oracle.stderr.is_empty(),
            "{args:?}"
        );
    }
}

#[test]
fn command_argv0_is_replaced() {
    let output = env(
        &["-i", "-a", "custom", "/bin/sh", "-c", "printf '%s' \"$0\""],
        &[],
    );
    assert_eq!(output.status.code(), Some(0), "{output:?}");
    assert_eq!(output.stdout, b"custom");
    assert!(output.stderr.is_empty(), "{output:?}");
}
