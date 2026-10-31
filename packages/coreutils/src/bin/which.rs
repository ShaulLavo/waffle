#[cfg(target_os = "wasi")]
#[path = "../which_query.rs"]
mod query;

#[cfg(target_os = "wasi")]
fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let path = std::env::var("PATH").ok();
    let cwd = std::env::var("PWD").unwrap_or_else(|_| "/".into());
    let lookup = waffle_coreutils::which::Lookup {
        cwd: &cwd,
        path: path.as_deref(),
        registered: query::registered,
    };
    let status = lookup.run(&args, &mut std::io::stdout(), &mut std::io::stderr());
    std::process::exit(status);
}

#[cfg(not(target_os = "wasi"))]
fn main() {
    eprintln!("which requires a Waffle registered-executable query host");
    std::process::exit(2);
}
