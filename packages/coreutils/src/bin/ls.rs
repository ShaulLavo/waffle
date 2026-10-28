extern crate uucore_files as uucore;

mod upstream {
    uucore::bin!(uu_ls);
}

fn main() {
    if let Ok(cwd) = std::env::var("PWD")
        && let Err(error) = std::env::set_current_dir(&cwd)
    {
        eprintln!("ls: cannot set working directory '{cwd}': {error}");
        std::process::exit(2);
    }
    upstream::main();
}
