fn main() {
    #[cfg(target_os = "wasi")]
    initialize_cwd();
    let args: Vec<String> = std::env::args().collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    std::process::exit(upstream_xargs::xargs_main(&args));
}

#[cfg(target_os = "wasi")]
fn initialize_cwd() {
    let cwd = std::env::var("PWD").unwrap_or_else(|_| "/".into());
    if let Err(error) = std::env::set_current_dir(&cwd) {
        eprintln!("xargs: {cwd}: {error}");
        std::process::exit(1);
    }
}
