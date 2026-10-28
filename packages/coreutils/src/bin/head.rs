// uutils coreutils head, MIT licensed. See docs/head.md and the distribution notices.
mod file_operations;

mod upstream {
    uucore::bin!(uu_head);
}

fn main() {
    #[cfg(target_os = "wasi")]
    file_operations::initialize_cwd("head");
    upstream::main();
}
