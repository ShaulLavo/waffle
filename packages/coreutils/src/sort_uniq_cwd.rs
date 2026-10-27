pub fn initialize(command: &str) {
    let Some(path) = std::env::var_os("PWD") else {
        return;
    };
    if let Err(error) = std::env::set_current_dir(&path) {
        eprintln!("{command}: set cwd {}: {error}", path.to_string_lossy());
        std::process::exit(1);
    }
}
