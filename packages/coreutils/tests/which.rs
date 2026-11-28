use std::cell::RefCell;
use waffle_coreutils::which::Lookup;
use waffle_program_support::path::absolute;

fn run(args: &[&str], path: Option<&str>, error: Option<i32>) -> (i32, String, String) {
    let queries = RefCell::new(Vec::new());
    let lookup = Lookup {
        cwd: "/work",
        path,
        registered: |path: &str, cwd: &str| {
            queries.borrow_mut().push(path.to_owned());
            if let Some(error) = error.filter(|_| path == "/bin/tool") {
                return Err(error);
            }
            let absolute = absolute(cwd, path);
            Ok(matches!(
                absolute.as_str(),
                "/bin/tool" | "/other/tool" | "/work/tool" | "/work/local/tool" | "/bin/-tool"
            ))
        },
    };
    let args = args.iter().map(|arg| (*arg).into()).collect::<Vec<_>>();
    let mut output = Vec::new();
    let mut errors = Vec::new();
    let status = lookup.run(&args, &mut output, &mut errors);
    assert!(queries.borrow().len() <= 8, "bounded query count");
    (
        status,
        String::from_utf8(output).unwrap(),
        String::from_utf8(errors).unwrap(),
    )
}

#[test]
fn registry_queries_preserve_path_order_and_all_matches() {
    assert_eq!(
        run(&["tool"], Some("/none:/other:/bin"), None),
        (0, "/other/tool\n".into(), "".into())
    );
    assert_eq!(
        run(&["-a", "tool"], Some("/other:/bin:/bin"), None),
        (0, "/other/tool\n/bin/tool\n/bin/tool\n".into(), "".into())
    );
}

#[test]
fn relative_empty_and_unset_path_have_explicit_behavior() {
    for path in ["", ":/bin", "local:/bin"] {
        let expected = if path.starts_with("local") {
            "/work/local/tool\n"
        } else {
            "/work/tool\n"
        };
        assert_eq!(
            run(&["tool"], Some(path), None),
            (0, expected.into(), "".into())
        );
    }
    assert_eq!(run(&["tool"], None, None), (1, "".into(), "".into()));
    assert_eq!(
        run(&["./tool", "/bin/tool"], None, None),
        (0, "/work/tool\n/bin/tool\n".into(), "".into())
    );
}

#[test]
fn misses_do_not_hide_later_operands_or_accept_directories() {
    assert_eq!(
        run(&["missing", "tool", "/bin"], Some("/bin"), None),
        (1, "/bin/tool\n".into(), "".into())
    );
    assert_eq!(
        run(&["--", "-tool"], Some("/bin"), None),
        (0, "/bin/-tool\n".into(), "".into())
    );
}

#[test]
fn invalid_options_and_missing_names_are_usage_errors() {
    for args in [
        vec![],
        vec!["-a"],
        vec!["--skip-alias", "tool"],
        vec!["-z", "tool"],
    ] {
        let (status, stdout, stderr) = run(&args, Some("/bin"), None);
        assert_eq!(status, 2, "{args:?}");
        assert!(stdout.is_empty());
        assert!(stderr.starts_with("which: "));
    }
}

#[test]
fn query_errors_are_not_silent_misses() {
    let (status, stdout, stderr) = run(&["tool"], Some("/bin"), Some(-52));
    assert_eq!(status, 2);
    assert!(stdout.is_empty());
    assert!(stderr.contains("executable query failed: WASI errno 52"));
}

#[test]
fn output_failure_is_not_a_successful_lookup() {
    struct BrokenPipe;
    impl std::io::Write for BrokenPipe {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::ErrorKind::BrokenPipe.into())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let lookup = Lookup {
        cwd: "/",
        path: Some("/bin"),
        registered: |_: &str, _: &str| Ok(true),
    };
    assert_eq!(
        lookup.run(&["tool".into()], &mut BrokenPipe, &mut Vec::new()),
        141
    );
}
