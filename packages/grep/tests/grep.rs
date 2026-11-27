#![cfg(not(target_os = "wasi"))]

use futures::FutureExt;
use serde_json::Value;
use std::collections::BTreeMap;
use std::future::Future;
use std::rc::Rc;
use waffle_grep::{Context, Invocation};
use waffle_program_support::{
    DEFAULT_LINE_BYTES,
    executor::{Cancel, Executor, JoinHandle},
    io::{Capture, Endpoint, FdTable, IoError, MemoryFs, OpenOptions, capture, pipe},
};

struct Output {
    status: i32,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

struct Rig {
    filesystem: MemoryFs,
    line_bytes: usize,
}

impl Rig {
    fn new() -> Self {
        Self::with_line_bytes(DEFAULT_LINE_BYTES)
    }

    fn with_line_bytes(line_bytes: usize) -> Self {
        Self {
            filesystem: MemoryFs::new(8 * 1024 * 1024),
            line_bytes,
        }
    }

    fn write(&self, path: &str, bytes: &[u8]) {
        let absolute = format!("/home/guest/{path}");
        if let Some((parent, _)) = absolute.rsplit_once('/')
            && !parent.is_empty()
        {
            self.filesystem.mkdir(parent, true).unwrap();
        }
        self.filesystem.write_file(&absolute, bytes).unwrap();
    }

    fn invocation(&self, args: &[&str], input: Option<Vec<u8>>) -> (Invocation, Capture, Capture) {
        let mut fds = FdTable::default();
        if let Some(input) = input {
            fds.insert(0, Endpoint::bytes(input));
        }
        let (output, output_capture) = capture(4 * 1024 * 1024);
        let (errors, error_capture) = capture(1024 * 1024);
        fds.insert(1, output);
        fds.insert(2, errors);
        let invocation = Invocation {
            args: args.iter().map(|arg| (*arg).to_owned()).collect(),
            env: BTreeMap::new(),
            cwd: "/home/guest".into(),
            fds,
            context: Context {
                cancel: Cancel::new(),
                filesystem: Rc::new(self.filesystem.clone()),
                line_bytes: self.line_bytes,
            },
        };
        (invocation, output_capture, error_capture)
    }

    fn run_fds(&self, invocation: Invocation, output: Capture, errors: Capture) -> Output {
        Output {
            status: block_on(waffle_grep::grep(invocation)),
            stdout: output.bytes(),
            stderr: errors.bytes(),
        }
    }

    fn run(&self, args: &[&str], input: &[u8]) -> Output {
        let (invocation, output, errors) = self.invocation(args, Some(input.to_vec()));
        self.run_fds(invocation, output, errors)
    }
}

fn finish<T: Clone + 'static>(executor: &Executor, job: JoinHandle<T>) -> T {
    for _ in 0..100_000 {
        if job.is_finished() {
            return job.now_or_never().expect("finished guest result");
        }
        executor.drive(1024);
    }
    panic!("guest did not finish within the bounded native run");
}

fn block_on<T: Clone + 'static>(future: impl Future<Output = T> + 'static) -> T {
    let executor = Executor::new();
    let job = executor.spawn(future);
    finish(&executor, job)
}

fn assert_run(rig: &Rig, args: &[&str], input: &[u8], status: i32, stdout: &[u8]) {
    let output = rig.run(args, input);
    assert_eq!(output.status, status, "{args:?}");
    assert_eq!(output.stdout, stdout, "{args:?}");
}

#[test]
fn grep_options_match_gnu_subset_and_statuses() {
    let cases: &[(&[&str], &[u8], i32, &[u8])] = &[
        (&["-nvi", "tick"], b"tick\nmiss\nTICK\n", 0, b"2:miss\n"),
        (&["-Ec", "^(ab)+$"], b"ab\nabab\na+b\n", 0, b"2\n"),
        (&["-Fin", "a+b"], b"a+b\naaab\nA+B", 0, b"1:a+b\n3:A+B\n"),
        (&["a+b"], b"a+b\naaab\n", 0, b"a+b\n"),
        (&["-c", "^\\(ab\\)\\+$"], b"ab\nabab\na+b\n", 0, b"2\n"),
        (&["-vqc", "tick"], b"tick\nmiss\n", 0, b""),
        (&["-c", "missing"], b"tick\n", 1, b"0\n"),
        (&["missing"], b"tick\n", 1, b""),
        (&["x\ndef"], b"abc\ndef\n", 0, b"def\n"),
        (&["x$"], b"x\r\n", 1, b""),
        (&["-n", ""], b"\n", 0, b"1:\n"),
        (&["-c", ""], b"", 1, b"0\n"),
        (&["--", "-needle"], b"-needle\n", 0, b"-needle\n"),
    ];
    let rig = Rig::new();
    for (args, input, status, stdout) in cases {
        assert_run(&rig, args, input, *status, stdout);
    }
    for args in [
        &[][..],
        &["-Z", "x"][..],
        &["-EF", "x"][..],
        &["-E", "["][..],
        &["missing-file-pattern", "no-such-file"][..],
    ] {
        let output = rig.run(args, b"");
        assert_eq!(output.status, 2, "{args:?}");
        assert!(output.stderr.starts_with(b"grep: "), "{args:?}");
    }
}

#[test]
fn grep_files_counts_prefixes_quiet_error_priority_and_exact_bytes() {
    let rig = Rig::new();
    rig.write("first", b"a\nx\na");
    rig.write("second", b"y\na\n");
    assert_run(
        &rig,
        &["-nc", "a", "first", "second"],
        b"",
        0,
        b"first:2\nsecond:1\n",
    );

    rig.write("bytes", b"x\0\xff\r\nother");
    assert_run(&rig, &["-Fn", "x", "bytes"], b"", 0, b"1:x\0\xff\r\n");

    rig.write("file", b"hit\n");
    let quiet = rig.run(&["-q", "hit", "missing", "file"], b"");
    assert_eq!(quiet.status, 0);
    assert!(quiet.stderr.starts_with(b"grep: missing:"));
    assert!(quiet.stdout.is_empty());

    let nonquiet = rig.run(&["hit", "missing", "file"], b"");
    assert_eq!(nonquiet.status, 2);
    assert_eq!(nonquiet.stdout, b"file:hit\n");
}

fn frozen_case(name: &str) -> Output {
    let rig = Rig::new();
    match name {
        "numbered inverted ignore case" => rig.run(&["-nvi", "hit"], b"hit\nMISS\nHIT\n"),
        "extended quantifiers" => rig.run(&["-nE", "^(ab)+$"], b"ab\nabab\na+b\n"),
        "fixed literal case insensitive" => rig.run(&["-Fin", "a+b"], b"a+b\naaab\nA+B"),
        "repeated explicit patterns" => rig.run(
            &["-n", "-e", "TODO", "-e", "FIXME"],
            b"TODO: one\nskip\nFIXME: two\n",
        ),
        "attached grouped pattern and later flags" => {
            rig.run(&["-nFea+b", "-i"], b"a+b\nA+B\naaab\n")
        }
        "dash pattern" => rig.run(&["-n", "-e", "-needle"], b"-needle\nother\n"),
        "empty pattern alternative" => rig.run(&["-ne", "missing", "-e", ""], b"one\n\ntwo"),
        "newline alternatives within explicit patterns" => {
            rig.run(&["-nE", "-e", "^a$\n^c$", "-e", "^d$"], b"a\nb\nc\nd\n")
        }
        "basic grouping across explicit patterns" => rig.run(
            &["-n", "-e", "^\\(ab\\)\\+$", "-e", "^a+b$"],
            b"ab\nabab\na+b\n",
        ),
        "forced single filename" => {
            rig.write("first", b"hit\nmiss\n");
            rig.run(&["-Hn", "hit", "first"], b"")
        }
        "suppressed multiple filenames" => {
            rig.write("first", b"hit\nmiss\n");
            rig.write("second", b"hit\n");
            rig.run(&["-hn", "hit", "first", "second"], b"")
        }
        "file plus explicit standard input" => {
            rig.write("first", b"hit\n");
            rig.run(&["-n", "hit", "first", "-"], b"hit\n")
        }
        "forced stdin filename" => rig.run(&["-Hn", "hit"], b"hit\n"),
        "last filename option wins" => {
            rig.write("first", b"hit\n");
            let mut output = rig.run(&["-Hh", "hit", "first"], b"");
            let second = rig.run(&["-hH", "hit", "first"], b"");
            output.status = second.status;
            output.stdout.extend(second.stdout);
            output.stderr.extend(second.stderr);
            output
        }
        "counts remain per operand" => {
            rig.write("first", b"hit\nmiss\nhit");
            rig.write("second", b"miss\n");
            rig.run(&["-hc", "-e", "hit", "first", "second"], b"")
        }
        "option terminator and dash filename" => {
            rig.write("-input", b"hit\n");
            rig.run(&["-n", "-e", "hit", "--", "-input"], b"")
        }
        "pattern option after operand" => {
            rig.write("first", b"hit\nmiss\n");
            rig.run(&["first", "-ne", "hit"], b"")
        }
        "no match status" => rig.run(&["-e", "absent", "-e", "missing"], b"hit\n"),
        "count no match status" => rig.run(&["-c", "-e", "absent"], b"hit\n"),
        "invalid regex status" => rig.run(&["-E", "-e", "["], b""),
        "missing explicit pattern status" => rig.run(&["-e"], b""),
        "missing file status" => rig.run(&["-e", "hit", "absent-file"], b""),
        "quiet success takes priority over file error" => {
            rig.write("first", b"hit\n");
            rig.run(&["-q", "-e", "hit", "absent-file", "first"], b"")
        }
        "non quiet error takes priority over match" => {
            rig.write("first", b"hit\n");
            rig.run(&["-h", "-e", "hit", "absent-file", "first"], b"")
        }
        "closed output is an error" => {
            let (mut invocation, output, errors) =
                rig.invocation(&["-e", "hit"], Some(b"hit\n".to_vec()));
            invocation.fds.remove(1);
            rig.run_fds(invocation, output, errors)
        }
        _ => panic!("missing native setup for frozen case {name}"),
    }
}

#[test]
fn grep_agent_usage_controls() {
    let cases: Value =
        serde_json::from_str(include_str!("fixtures/grep-usage-cases.json")).unwrap();
    for case in cases.as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        if matches!(
            name,
            "pipeline output reaches downstream builtin"
                | "closed pipeline reader propagates broken pipe"
        ) {
            continue;
        }
        let output = frozen_case(name);
        assert_eq!(
            output.status,
            i32::try_from(case["status"].as_i64().unwrap()).unwrap(),
            "{name}"
        );
        assert_eq!(
            output.stdout,
            case["stdout"].as_str().unwrap().as_bytes(),
            "{name}"
        );
        assert_eq!(
            !output.stderr.is_empty(),
            case["stderrPresent"].as_bool().unwrap(),
            "{name}"
        );
    }
}

#[test]
fn grep_basic_anchors_only_at_bre_branch_boundaries() {
    let lines = b"a^b\na$b\na\n^a\na$\n^^a\na$$\nab\nb\n^b\n";
    let cases = [
        ("a^b", "1:a^b\n"),
        ("a$b", "2:a$b\n"),
        ("^^a", "4:^a\n"),
        ("a$$", "5:a$\n"),
        (r"a\^b", "1:a^b\n"),
        (r"a\$b", "2:a$b\n"),
        (r"\(^a$\)", "3:a\n"),
        (r"\(^a$\)\|\(^b$\)", "3:a\n9:b\n"),
        (r"z\|^b", "9:b\n"),
        (r"a$\|z", "3:a\n4:^a\n6:^^a\n"),
        (r"z\|^^b", "10:^b\n"),
        (r"\(^\^a\)", "4:^a\n"),
        (r"\(a$\)b", ""),
        (r"a\(^b\)", ""),
        ("(^a", ""),
        ("z|^b", ""),
        ("a$)", ""),
    ];
    let rig = Rig::new();
    rig.write("lines", lines);
    for (pattern, expected) in cases {
        let output = rig.run(&["-n", pattern, "lines"], b"");
        assert_eq!(output.status, i32::from(expected.is_empty()), "{pattern}");
        assert_eq!(output.stdout, expected.as_bytes(), "{pattern}");
    }
    assert_run(&rig, &["-nE", "a^b", "lines"], b"", 1, b"");
    assert_run(&rig, &["-nF", "a$b", "lines"], b"", 0, b"2:a$b\n");
}

#[test]
fn grep_record_and_regex_admission_are_bounded() {
    let rig = Rig::with_line_bytes(4);
    let record = rig.run(&["."], b"12345");
    assert_eq!(record.status, 2);
    assert!(String::from_utf8_lossy(&record.stderr).contains("record limit"));

    let rig = Rig::new();
    let long = "x".repeat(4097);
    let pattern = rig.run(&[&long], b"");
    assert_eq!(pattern.status, 2);
    assert!(String::from_utf8_lossy(&pattern.stderr).contains("pattern byte limit"));

    let regex = rig.run(&["-E", "a{1000000}"], b"");
    assert_eq!(regex.status, 2);
    assert!(regex.stderr.starts_with(b"grep: "));

    let first = "a".repeat(2048);
    let second = "b".repeat(2048);
    let repeated = rig.run(&["-e", &first, "-e", &second], b"");
    assert_eq!(repeated.status, 2);
    assert!(String::from_utf8_lossy(&repeated.stderr).contains("pattern byte limit"));
}

#[test]
fn grep_descriptor_paths_reopen_regular_files_with_independent_offsets() {
    for path in ["/dev/fd/4", "/proc/self/fd/4", "/dev//fd/4"] {
        let rig = Rig::new();
        rig.write("file", b"one\ntwo\n");
        let source = rig
            .filesystem
            .open("/home/guest/file", &OpenOptions::default())
            .unwrap();
        let first = block_on({
            let source = source.clone();
            async move {
                let mut bytes = [0; 4];
                source.read(&mut bytes).await.map(|count| (bytes, count))
            }
        });
        assert_eq!(first, Ok((*b"one\n", 4)));

        let (mut invocation, output, errors) = rig.invocation(&["one", path], None);
        invocation.fds.insert(4, source.clone());
        let grep = rig.run_fds(invocation, output, errors);
        assert_eq!(grep.status, 0, "{path}");
        assert_eq!(grep.stdout, b"one\n", "{path}");

        let next = block_on(async move {
            let mut bytes = [0; 4];
            source.read(&mut bytes).await.map(|count| (bytes, count))
        });
        assert_eq!(next, Ok((*b"two\n", 4)), "{path}");
    }
}

#[test]
fn grep_closed_descriptor_errors_keep_operand_and_quiet_priority() {
    for path in ["/dev/fd/4", "/proc/self/fd/5"] {
        let rig = Rig::new();
        rig.write("file", b"hit\n");
        let output = rig.run(&["-q", "hit", path, "file"], b"");
        assert_eq!(output.status, 0, "{path}");
        assert!(output.stderr.starts_with(b"grep: "), "{path}");
        assert!(output.stdout.is_empty(), "{path}");
    }
}

#[test]
fn grep_streams_matching_lines_before_producer_exit_and_cancels() {
    let rig = Rig::new();
    let (reader, writer) = pipe();
    let (mut invocation, output, _) = rig.invocation(&["tick"], None);
    invocation.fds.insert(0, reader);
    let cancel = invocation.context.cancel.clone();
    let executor = Executor::new();
    let job = executor.spawn(waffle_grep::grep(invocation));
    assert_eq!(writer.write(b"tick 0\n").now_or_never(), Some(Ok(7)));

    for _ in 0..100 {
        executor.drive(128);
        if output.bytes() == b"tick 0\n" {
            break;
        }
    }
    assert_eq!(output.bytes(), b"tick 0\n");
    assert!(!job.is_finished());
    cancel.cancel();
    assert_eq!(finish(&executor, job), 130);
    drop(writer);
}

#[test]
fn grep_quiet_returns_before_eof_and_closes_reader() {
    let rig = Rig::new();
    let (reader, writer) = pipe();
    let (mut invocation, output, _) = rig.invocation(&["-q", "tick"], None);
    invocation.fds.insert(0, reader);
    let executor = Executor::new();
    let job = executor.spawn(waffle_grep::grep(invocation));
    assert_eq!(writer.write(b"tick\n").now_or_never(), Some(Ok(5)));
    assert_eq!(finish(&executor, job), 0);
    assert!(output.is_empty());
    assert_eq!(
        writer.write(b"after").now_or_never(),
        Some(Err(IoError::BrokenPipe))
    );
}

#[test]
fn grep_unmatched_input_observes_cancellation_without_output() {
    let rig = Rig::new();
    let (reader, writer) = pipe();
    let (mut invocation, output, _) = rig.invocation(&["unmatched"], None);
    invocation.fds.insert(0, reader);
    let cancel = invocation.context.cancel.clone();
    let executor = Executor::new();
    let job = executor.spawn(waffle_grep::grep(invocation));
    assert_eq!(writer.write(b"miss\n").now_or_never(), Some(Ok(5)));
    executor.drive(128);
    assert!(!job.is_finished());
    assert!(output.is_empty());
    cancel.cancel();
    assert_eq!(finish(&executor, job), 130);
    drop(writer);
}

#[test]
fn grep_pre_cancelled_ready_input_has_interrupt_status() {
    let rig = Rig::new();
    let (invocation, output, errors) = rig.invocation(&["."], Some(b"match\n".to_vec()));
    invocation.context.cancel.cancel();
    let output = rig.run_fds(invocation, output, errors);
    assert_eq!(output.status, 130);
    assert!(output.stdout.is_empty());
}

#[test]
fn grep_streams_more_than_one_mib_without_accumulating_output() {
    let mut input = Vec::with_capacity(2_688_895);
    for number in 1..=400_000 {
        input.extend_from_slice(number.to_string().as_bytes());
        input.push(b'\n');
    }
    assert_eq!(input.len(), 2_688_895);
    let rig = Rig::new();
    let output = rig.run(&["-E", "^[0-9]+$"], &input);
    assert_eq!(output.status, 0);
    assert_eq!(output.stdout, input);
}

#[test]
fn grep_propagates_broken_pipe() {
    let rig = Rig::new();
    let (reader, writer) = pipe();
    drop(reader);
    let (mut invocation, output, errors) =
        rig.invocation(&["hit"], Some(b"hit payload\n".to_vec()));
    invocation.fds.insert(1, writer);
    let output = rig.run_fds(invocation, output, errors);
    assert_eq!(output.status, 141);
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
}

#[test]
fn grep_directory_without_recursive_reports_is_a_directory() {
    let rig = Rig::new();
    rig.write("src/app.ts", b"ERROR: boom\n");

    let dot = rig.run(&["-i", "error", "."], b"");
    assert_eq!(dot.status, 2);
    assert!(dot.stdout.is_empty());
    assert_eq!(dot.stderr, b"grep: .: Is a directory\n");

    let dir = rig.run(&["-i", "error", "src"], b"");
    assert_eq!(dir.status, 2);
    assert!(dir.stdout.is_empty());
    assert_eq!(dir.stderr, b"grep: src: Is a directory\n");

    // Non-directory operand after directory still scans and reports directory error
    rig.write("top.txt", b"error here\n");
    let mixed = rig.run(&["-i", "error", "src", "top.txt"], b"");
    assert_eq!(mixed.status, 2);
    assert_eq!(mixed.stdout, b"top.txt:error here\n");
    assert_eq!(mixed.stderr, b"grep: src: Is a directory\n");
}

#[test]
fn grep_recursive_options_traversal_and_exclude_dir() {
    let rig = Rig::new();
    rig.write("src/a.ts", b"first Error\nok\n");
    rig.write("src/nested/b.ts", b"second ERROR\n");
    rig.write("node_modules/pkg/index.js", b"ignored error\n");
    rig.write("dist-web/bundle.js", b"built error\n");
    rig.write("cache*old/stale.js", b"cached error\n");

    // -ri with trailing slash keeps clean paths (no double slash)
    assert_run(
        &rig,
        &["-ri", "error", "src/"],
        b"",
        0,
        b"src/a.ts:first Error\nsrc/nested/b.ts:second ERROR\n",
    );

    // --recursive with no file operands omits './' (matching GNU grep) and excludes glob names
    // containing literal '*' characters such as 'cache*old'
    assert_run(
        &rig,
        &[
            "--recursive",
            "-in",
            "--exclude-dir=node_modules",
            "--exclude-dir",
            "dist-*",
            "--exclude-dir=cache*",
            "error",
        ],
        b"",
        0,
        b"src/a.ts:1:first Error\nsrc/nested/b.ts:1:second ERROR\n",
    );

    // Explicit '.' operand retains its './' prefix (matching GNU grep)
    assert_run(
        &rig,
        &[
            "-rin",
            "--exclude-dir=node_modules",
            "--exclude-dir=dist-*",
            "--exclude-dir=cache*",
            "error",
            ".",
        ],
        b"",
        0,
        b"./src/a.ts:1:first Error\n./src/nested/b.ts:1:second ERROR\n",
    );

    // -h suppresses filename prefix during recursive traversal
    assert_run(
        &rig,
        &["-Rih", "error", "src"],
        b"",
        0,
        b"first Error\nsecond ERROR\n",
    );

    // Single regular file operand under -r keeps GNU no-prefix default
    assert_run(
        &rig,
        &["-ri", "error", "src/a.ts"],
        b"",
        0,
        b"first Error\n",
    );

    // Excluding the root operand directory itself skips it cleanly (status 1, no error)
    let skipped = rig.run(&["-r", "--exclude-dir=src", "Error", "src/"], b"");
    assert_eq!(skipped.status, 1);
    assert!(skipped.stdout.is_empty());
    assert!(skipped.stderr.is_empty());

    // -q stops early with status 0 across recursive traversal
    let quiet = rig.run(&["-riq", "error", "src"], b"");
    assert_eq!(quiet.status, 0);
    assert!(quiet.stdout.is_empty());
    assert!(quiet.stderr.is_empty());

    // Unsupported long option and missing --exclude-dir argument fail with status 2
    let bad_long = rig.run(&["--unknown-flag", "error"], b"");
    assert_eq!(bad_long.status, 2);
    assert_eq!(
        bad_long.stderr,
        b"grep: unsupported option: --unknown-flag\n"
    );

    let missing_exclude = rig.run(&["-r", "--exclude-dir"], b"");
    assert_eq!(missing_exclude.status, 2);
    assert!(missing_exclude.stderr.starts_with(b"grep: "));
}

#[test]
fn grep_handles_eisdir_fallback_and_recursive_symlinks_and_cycles() {
    use futures::future::LocalBoxFuture;
    use waffle_program_support::io::{Directory, FileKind, FileMetadata, FileSystem};

    struct EisdirFallbackFs;
    impl FileSystem for EisdirFallbackFs {
        fn mkdir<'a>(
            &'a self,
            _path: &'a str,
            _parents: bool,
        ) -> LocalBoxFuture<'a, Result<(), IoError>> {
            Box::pin(async { Err(IoError::Unsupported) })
        }
        fn open<'a>(
            &'a self,
            _path: &'a str,
            _options: &'a OpenOptions,
        ) -> LocalBoxFuture<'a, Result<Endpoint, IoError>> {
            Box::pin(async { Err(IoError::Runtime(31)) })
        }
    }

    let rig = Rig::new();
    let (mut invocation, output, errors) = rig.invocation(&["error", "some_dir"], None);
    invocation.context.filesystem = Rc::new(EisdirFallbackFs);
    let eisdir_out = rig.run_fds(invocation, output, errors);
    assert_eq!(eisdir_out.status, 2);
    assert!(eisdir_out.stdout.is_empty());
    assert_eq!(eisdir_out.stderr, b"grep: some_dir: Is a directory\n");

    struct SymlinkFs {
        inner: MemoryFs,
    }
    impl FileSystem for SymlinkFs {
        fn mkdir<'a>(
            &'a self,
            path: &'a str,
            parents: bool,
        ) -> LocalBoxFuture<'a, Result<(), IoError>> {
            let result = self.inner.mkdir(path, parents);
            Box::pin(async move { result })
        }
        fn stat<'a>(
            &'a self,
            path: &'a str,
            follow_symlinks: bool,
        ) -> LocalBoxFuture<'a, Result<FileMetadata, IoError>> {
            let target = match path {
                "/home/guest/dir/link_file" if !follow_symlinks => {
                    return Box::pin(async move {
                        let mut meta = self.inner.stat("/home/guest/target.txt", true)?;
                        meta.kind = FileKind::Symlink;
                        Ok(meta)
                    });
                }
                "/home/guest/dir/link_file" => "/home/guest/target.txt",
                "/home/guest/dir/loop_link" if !follow_symlinks => {
                    return Box::pin(async move {
                        let mut meta = self.inner.stat("/home/guest/dir", true)?;
                        meta.kind = FileKind::Symlink;
                        Ok(meta)
                    });
                }
                "/home/guest/dir/loop_link" => "/home/guest/dir",
                _ => path,
            };
            let result = self.inner.stat(target, follow_symlinks);
            Box::pin(async move { result })
        }
        fn open_dir<'a>(
            &'a self,
            path: &'a str,
        ) -> LocalBoxFuture<'a, Result<Rc<dyn Directory>, IoError>> {
            let mapped = if path == "/home/guest/dir/loop_link" {
                "/home/guest/dir"
            } else {
                path
            };
            self.inner.open_dir(mapped)
        }
        fn open<'a>(
            &'a self,
            path: &'a str,
            options: &'a OpenOptions,
        ) -> LocalBoxFuture<'a, Result<Endpoint, IoError>> {
            let mapped = if path == "/home/guest/dir/link_file" {
                "/home/guest/target.txt"
            } else {
                path
            };
            let result = self.inner.open(mapped, options);
            Box::pin(async move { result })
        }
    }

    let sym_rig = Rig::new();
    sym_rig.write("target.txt", b"linked error\n");
    sym_rig.write("dir/real.txt", b"real error\n");
    // Place placeholder entries so MemoryFs::open_dir lists link_file and loop_link inside dir
    sym_rig.write("dir/link_file", b"");
    sym_rig.write("dir/loop_link", b"");

    // -r skips symlinks encountered during directory traversal (no loop error, no symlink match)
    let (mut inv_r, out_r, err_r) = sym_rig.invocation(&["-r", "error", "dir"], None);
    inv_r.context.filesystem = Rc::new(SymlinkFs {
        inner: sym_rig.filesystem.clone(),
    });
    let res_r = sym_rig.run_fds(inv_r, out_r, err_r);
    assert_eq!(res_r.status, 0);
    assert_eq!(res_r.stdout, b"dir/real.txt:real error\n");
    assert!(res_r.stderr.is_empty());

    // -R follows symlinks and detects directory cycles cleanly without looping
    let (mut inv_big_r, out_big_r, err_big_r) = sym_rig.invocation(&["-R", "error", "dir"], None);
    inv_big_r.context.filesystem = Rc::new(SymlinkFs {
        inner: sym_rig.filesystem.clone(),
    });
    let res_big_r = sym_rig.run_fds(inv_big_r, out_big_r, err_big_r);
    assert_eq!(res_big_r.status, 2);
    assert_eq!(
        res_big_r.stdout,
        b"dir/link_file:linked error\ndir/real.txt:real error\n"
    );
    assert!(String::from_utf8_lossy(&res_big_r.stderr).contains("recursive directory loop"));
}
