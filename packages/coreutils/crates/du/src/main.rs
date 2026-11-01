#[cfg(target_os = "wasi")]
#[path = "../../../src/sort_uniq_cwd.rs"]
mod cwd;

mod upstream {
    uucore::bin!(uu_du);
}

fn main() {
    #[cfg(target_os = "wasi")]
    cwd::initialize("du");
    upstream::main();
}
