extern crate uucore_files as uucore;
mod file_operations;
mod upstream {
    uucore::bin!(uu_cp);
}
fn main() {
    #[cfg(target_os = "wasi")]
    file_operations::initialize_cwd("cp");
    upstream::main();
}
