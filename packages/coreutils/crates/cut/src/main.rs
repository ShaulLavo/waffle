mod upstream {
    uucore::bin!(uu_cut);
}

fn main() {
    #[cfg(target_os = "wasi")]
    initialize_cwd();
    upstream::main();
}

#[cfg(target_os = "wasi")]
fn initialize_cwd() {
    // Waffle supplies PWD; wasi-libc starts at the preopen root.
    let Ok(cwd) = std::env::var("PWD") else {
        return;
    };
    std::env::set_current_dir(&cwd).unwrap_or_else(|error| {
        eprintln!("cut: set cwd {cwd}: {error}");
        std::process::exit(1);
    });
}
