#[path = "../cwd.rs"]
mod cwd;

mod upstream {
    uucore::bin!(uu_sha512sum);
}

fn main() {
    uucore::checksum::stdio::initialize();
    cwd::initialize("sha512sum");
    upstream::main();
}
