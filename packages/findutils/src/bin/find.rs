// findutils 0.11.0, MIT licensed. See docs/find.md and the distribution notices.

use std::ffi::OsString;

fn collect_utf8_args(args: impl Iterator<Item = OsString>) -> Result<Vec<String>, OsString> {
    args.map(OsString::into_string).collect()
}

fn main() {
    uucore::panic::mute_sigpipe_panic();
    if let Ok(cwd) = std::env::var("PWD")
        && let Err(error) = std::env::set_current_dir(&cwd)
    {
        eprintln!("find: cannot set working directory '{cwd}': {error}");
        std::process::exit(2);
    }
    let args = match collect_utf8_args(std::env::args_os()) {
        Ok(args) => args,
        Err(invalid) => {
            eprintln!(
                "find: invalid (non-UTF-8) argument: {}",
                invalid.to_string_lossy()
            );
            std::process::exit(1);
        }
    };
    let args = args.iter().map(String::as_str).collect::<Vec<_>>();
    let status = findutils::find::find_main(&args, &findutils::find::StandardDependencies::new());
    std::process::exit(status);
}
