#[cfg(target_os = "wasi")]
#[path = "../sort_uniq_cwd.rs"]
mod cwd;

mod upstream {
    uucore::bin!(uu_sort);
}

fn main() {
    #[cfg(target_os = "wasi")]
    cwd::initialize("sort");
    upstream::main();
}
