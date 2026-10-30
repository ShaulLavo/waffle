#[path = "../cwd.rs"]
mod cwd;

mod upstream {
    uucore::bin!(uu_sha256sum);
}

fn main() {
    cwd::initialize("sha256sum");
    upstream::main();
}
