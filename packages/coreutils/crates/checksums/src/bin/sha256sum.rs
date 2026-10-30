#[path = "../cwd.rs"]
mod cwd;

mod upstream {
    uucore::bin!(uu_sha256sum);
}

fn main() {
    uucore::checksum::stdio::initialize();
    cwd::initialize("sha256sum");
    upstream::main();
}
