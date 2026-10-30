pub fn initialize(name: &str) {
    let Ok(cwd) = std::env::var("PWD") else {
        return;
    };
    if let Err(error) = std::env::set_current_dir(&cwd) {
        eprintln!("{name}: cannot set working directory '{cwd}': {error}");
        std::process::exit(2);
    }
}
