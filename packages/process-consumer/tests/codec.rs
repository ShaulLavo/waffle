use std::collections::BTreeMap;
use waffle_process_consumer::{
    DescriptorBinding, Error, MAX_REQUEST_BYTES, Outcome, Request, decode_host_result,
};

fn request() -> Request {
    Request {
        executable: "/bin/tool".into(),
        argv: vec!["custom argv0".into(), "".into(), "a b\n\"\\雪".into()],
        env: BTreeMap::from([("ONLY".into(), "value=\n雪".into())]),
        cwd: "/workspace/sub".into(),
        fds: vec![
            DescriptorBinding::inherit(0),
            DescriptorBinding {
                child: 1,
                parent: 9,
            },
            DescriptorBinding::inherit(1_000_000),
        ],
    }
}

#[test]
fn launch_preserves_custom_argv0_empty_arguments_env_cwd_and_sparse_bindings() {
    let input = request();
    let json: serde_json::Value = serde_json::from_slice(&input.encode().unwrap()).unwrap();
    assert_eq!(json["argv"], serde_json::json!(input.argv));
    assert_eq!(json["env"], serde_json::json!(input.env));
    assert_eq!(json["cwd"], "/workspace/sub");
    assert_eq!(json["executable"], "/bin/tool");
    assert_eq!(json["job"], 0);
    assert_eq!(json["jobLifetime"], "caller-fatal");
    assert_eq!(
        json["fds"],
        serde_json::json!([{ "child": 0, "parent": 0 }, { "child": 1, "parent": 9 }, { "child": 1000000, "parent": 1000000 }])
    );
}

#[test]
fn empty_environment_and_closed_stdio_are_not_filled_in() {
    let mut input = request();
    input.env.clear();
    input.fds.clear();
    input.argv.clear();
    let json: serde_json::Value = serde_json::from_slice(&input.encode().unwrap()).unwrap();
    assert_eq!(json["env"], serde_json::json!({}));
    assert_eq!(json["fds"], serde_json::json!([]));
    assert_eq!(json["argv"], serde_json::json!([]));
}

#[test]
fn reject_ambiguous_c_strings_relative_cwd_and_duplicate_targets() {
    let mut input = request();
    input.argv.push("bad\0argument".into());
    assert!(matches!(input.encode(), Err(Error::InvalidInput(_))));
    input.argv.pop();
    input.cwd = "relative".into();
    assert!(matches!(input.encode(), Err(Error::InvalidInput(_))));
    input.cwd = "/".into();
    input.fds.push(DescriptorBinding {
        child: 1,
        parent: 2,
    });
    assert!(matches!(input.encode(), Err(Error::InvalidInput(_))));
}

#[test]
fn bound_encoded_size_including_json_escape_expansion() {
    let mut input = request();
    input.argv = vec!["\n".repeat(MAX_REQUEST_BYTES / 2)];
    assert_eq!(input.encode(), Err(Error::RequestTooLarge));
    input.argv = vec!["a".repeat(MAX_REQUEST_BYTES)];
    assert_eq!(input.encode(), Err(Error::RequestTooLarge));
    input.argv = vec!["a".repeat(4096)];
    assert!(input.encode().unwrap().len() < MAX_REQUEST_BYTES);
}

fn record(kind: u32, value: i32) -> [u8; 8] {
    let bits = u64::from(kind) | (u64::from(value.cast_unsigned()) << u32::BITS);
    bits.to_le_bytes()
}

#[test]
fn startup_failures_signals_and_real_exits_have_distinct_outcomes() {
    assert_eq!(Outcome::decode(record(0, 127)), Ok(Outcome::Exited(127)));
    assert_eq!(Outcome::decode(record(2, 44)), Ok(Outcome::StartFailed(44)));
    assert_eq!(Outcome::decode(record(1, 15)), Ok(Outcome::Signaled(15)));
    assert_eq!(Outcome::Exited(126).shell_status(), 126);
    assert_eq!(Outcome::Exited(127).shell_status(), 127);
    assert_eq!(Outcome::Signaled(15).shell_status(), 143);
    assert_eq!(Outcome::StartFailed(44).shell_status(), 127);
    for errno in [2, 54, 45, 48, 6, 29] {
        assert_eq!(
            Outcome::decode(record(2, errno)).unwrap().shell_status(),
            126
        );
    }
}

#[test]
fn reject_unknown_tags_invalid_signals_and_invented_start_errnos() {
    for (kind, value) in [
        (3, 0),
        (u32::MAX, 0),
        (1, 0),
        (1, 32),
        (1, 33),
        (1, 65),
        (2, 0),
        (2, -44),
        (2, 127),
    ] {
        assert_eq!(
            Outcome::decode(record(kind, value)),
            Err(Error::InvalidRecord)
        );
    }
}

#[test]
fn host_call_errors_are_not_startup_failures_and_min_does_not_overflow() {
    assert_eq!(decode_host_result("spawn", 7), Ok(7));
    assert_eq!(
        decode_host_result("wait", -6),
        Err(Error::Host {
            operation: "wait",
            errno: 6
        })
    );
    assert_eq!(
        decode_host_result("wait", i32::MIN),
        Err(Error::InvalidRecord)
    );
}
