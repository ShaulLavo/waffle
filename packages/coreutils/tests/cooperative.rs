#![cfg(not(target_os = "wasi"))]

use futures::{FutureExt, future::LocalBoxFuture};
use std::collections::BTreeMap;
use std::future::Future;
use std::rc::Rc;
use waffle_coreutils::{Context, Invocation};
use waffle_program_support::{
    DEFAULT_LINE_BYTES,
    executor::{Cancel, Executor},
    io::{Capture, Endpoint, FdTable, FileSystem, IoError, MemoryFs, OpenOptions, capture},
};

fn invocation(
    args: &[&str],
    input: Option<Vec<u8>>,
    filesystem: &MemoryFs,
) -> (Invocation, Capture, Capture) {
    let mut fds = FdTable::default();
    if let Some(input) = input {
        fds.insert(0, Endpoint::bytes(input));
    }
    let (output, output_capture) = capture(1024 * 1024);
    let (errors, error_capture) = capture(1024 * 1024);
    fds.insert(1, output);
    fds.insert(2, errors);
    let invocation = Invocation {
        args: args.iter().map(|arg| (*arg).to_owned()).collect(),
        env: BTreeMap::new(),
        cwd: "/work".into(),
        fds,
        context: Context {
            cancel: Cancel::new(),
            filesystem: Rc::new(filesystem.clone()),
            line_bytes: DEFAULT_LINE_BYTES,
        },
    };
    (invocation, output_capture, error_capture)
}

fn run(future: impl Future<Output = i32> + 'static) -> i32 {
    let executor = Executor::new();
    let mut job = executor.spawn(future);
    while !job.is_finished() {
        executor.drive(64);
    }
    job.now_or_never().expect("finished guest status")
}

#[test]
fn seq_preserves_bytes_and_usage_status() {
    let filesystem = MemoryFs::new(4096);
    let (input, output, _) = invocation(&["2", "4"], None, &filesystem);
    assert_eq!(run(waffle_coreutils::seq(input)), 0);
    assert_eq!(output.bytes(), b"2\n3\n4\n");

    let (input, output, _) = invocation(&["not-a-number"], None, &filesystem);
    assert_eq!(run(waffle_coreutils::seq(input)), 2);
    assert!(output.is_empty());
}

#[test]
fn cat_and_tail_preserve_exact_file_bytes() {
    let filesystem = MemoryFs::new(4096);
    filesystem.mkdir("/work", false).unwrap();
    filesystem
        .write_file("/work/input", b"one\ntwo\nthree\0")
        .unwrap();
    let (input, output, _) = invocation(&["input"], None, &filesystem);
    assert_eq!(run(waffle_coreutils::cat(input)), 0);
    assert_eq!(output.bytes(), b"one\ntwo\nthree\0");

    let (input, output, _) = invocation(&["-n2", "input"], None, &filesystem);
    assert_eq!(run(waffle_coreutils::tail(input)), 0);
    assert_eq!(output.bytes(), b"two\nthree\0");
}

#[test]
fn guest_file_operands_preserve_components_for_filesystem_lookup() {
    let filesystem = MemoryFs::new(4096);
    filesystem.mkdir("/work", false).unwrap();
    filesystem.write_file("/work/input", b"data\n").unwrap();

    let (input, output, _) = invocation(&["./input/"], None, &filesystem);
    assert_eq!(run(waffle_coreutils::cat(input)), 1);
    assert!(output.is_empty());

    let (input, output, _) = invocation(&["missing/../input"], None, &filesystem);
    assert_eq!(run(waffle_coreutils::tail(input)), 1);
    assert!(output.is_empty());

    let (input, _, errors) = invocation(&["-p", "input/../child"], None, &filesystem);
    assert_eq!(run(waffle_coreutils::mkdir(input)), 1);
    assert!(filesystem.stat("/work/child", true).is_err());
    assert_eq!(errors.bytes(), b"mkdir: input/../child: not a directory\n");
}

#[test]
fn mkdir_preserves_parent_creation_and_error_status() {
    let filesystem = MemoryFs::new(4096);
    let (input, _, errors) = invocation(&["-p", "a/b", ""], None, &filesystem);
    assert_eq!(run(waffle_coreutils::mkdir(input)), 1);
    assert!(filesystem.stat("/work/a/b", true).is_ok());
    assert_eq!(errors.bytes(), b"mkdir: : invalid path\n");
}

#[test]
fn mkdir_passes_all_parent_components_to_the_filesystem_policy() {
    const OPERAND: &str = "/usr/missing/../../tmp/target";
    struct DirectoryPolicy;

    impl FileSystem for DirectoryPolicy {
        fn mkdir<'a>(
            &'a self,
            path: &'a str,
            parents: bool,
        ) -> LocalBoxFuture<'a, Result<(), IoError>> {
            assert_eq!(path, OPERAND);
            assert!(parents);
            Box::pin(async { Err(IoError::Runtime(69)) })
        }

        fn open<'a>(
            &'a self,
            _: &'a str,
            _: &'a OpenOptions,
        ) -> LocalBoxFuture<'a, Result<Endpoint, IoError>> {
            Box::pin(async { Err(IoError::Unsupported) })
        }
    }

    let (mut input, _, errors) = invocation(&["-p", OPERAND], None, &MemoryFs::new(0));
    input.context.filesystem = Rc::new(DirectoryPolicy);
    assert_eq!(run(waffle_coreutils::mkdir(input)), 1);
    assert_eq!(
        errors.bytes(),
        b"mkdir: /usr/missing/../../tmp/target: runtime I/O error: errno 69\n"
    );
}

#[test]
fn cancelled_input_has_interrupt_status() {
    let filesystem = MemoryFs::new(4096);
    let (mut input, output, _) = invocation(&[], Some(b"unused".to_vec()), &filesystem);
    input.context.cancel.cancel();
    assert_eq!(run(waffle_coreutils::cat(input)), 130);
    assert!(output.is_empty());
}
