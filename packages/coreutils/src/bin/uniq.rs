#[cfg(target_os = "wasi")]
#[path = "../sort_uniq_cwd.rs"]
mod cwd;

mod upstream {
    uucore::bin!(uu_uniq);
}

fn main() {
    #[cfg(target_os = "wasi")]
    cwd::initialize("uniq");
    upstream::main();
}
