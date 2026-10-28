fn main() {
    #[cfg(target_os = "wasi")]
    if let Err(error) = upstream_xargs::initialize_cwd() {
        eprintln!("xargs: cannot initialize cwd: {error}");
        std::process::exit(1);
    }
    let args: Vec<String> = std::env::args().collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    std::process::exit(upstream_xargs::xargs_main(&args));
}
