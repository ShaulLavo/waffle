#[cfg(target_os = "wasi")]
pub fn initialize_cwd(name: &str) {
    // Waffle supplies PWD, while WASI libc starts at the preopen root.
    let Ok(cwd) = std::env::var("PWD") else {
        return;
    };
    if let Err(error) = std::env::set_current_dir(&cwd) {
        eprintln!("{name}: set cwd {cwd}: {error}");
        std::process::exit(1);
    }
}
