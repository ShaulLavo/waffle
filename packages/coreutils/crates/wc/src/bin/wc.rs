// uutils coreutils wc, MIT licensed. See docs/wc.md and the distribution notices.
mod program {
    uucore::bin!(uu_wc);
}

fn main() {
    configure_directory();
    program::main();
}

#[cfg(not(target_os = "wasi"))]
fn configure_directory() {}

#[cfg(target_os = "wasi")]
fn configure_directory() {
    // Waffle passes the process directory as PWD; WASI libc starts at the preopen root.
    let cwd = std::env::var("PWD").unwrap_or_else(|_| "/".into());
    std::env::set_current_dir(&cwd).unwrap_or_else(|error| {
        eprintln!("wc: set cwd {cwd}: {error}");
        std::process::exit(1);
    });
}
