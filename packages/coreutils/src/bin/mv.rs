extern crate uucore_files as uucore;
mod file_operations;
mod upstream {
    uucore::bin!(uu_mv);
}
fn main() {
    #[cfg(target_os = "wasi")]
    file_operations::initialize_cwd("mv");
    upstream::main();
}
