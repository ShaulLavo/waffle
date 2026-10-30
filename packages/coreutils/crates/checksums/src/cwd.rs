use std::io;

#[link(wasm_import_module = "runtime_proc")]
unsafe extern "C" {
    // Waffle's process cwd: returns the full byte length, writing only when it fits.
    fn cwd(output: *mut u8, capacity: usize) -> i32;
}

/// Enters the runtime's launch cwd; PWD is ordinary environment and may name another directory.
pub fn initialize(name: &str) {
    if let Err(error) = enter_process_cwd() {
        eprintln!("{name}: cannot set working directory: {error}");
        std::process::exit(2);
    }
}

fn enter_process_cwd() -> io::Result<()> {
    let mut bytes = vec![0; 4096];
    let mut length = process_cwd(&mut bytes)?;
    if length > bytes.len() {
        bytes.resize(length, 0);
        length = process_cwd(&mut bytes)?;
    }
    let path = bytes
        .get(..length)
        .ok_or_else(|| io::Error::other("process cwd changed length"))?;
    let path = std::str::from_utf8(path).map_err(io::Error::other)?;
    std::env::set_current_dir(path)
}

fn process_cwd(bytes: &mut [u8]) -> io::Result<usize> {
    let result = unsafe { cwd(bytes.as_mut_ptr(), bytes.len()) };
    if result < 0 {
        return Err(io::Error::other(format!("runtime cwd errno {}", -i64::from(result))));
    }
    usize::try_from(result).map_err(io::Error::other)
}
