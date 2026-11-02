#[path = "../cwd.rs"]
mod cwd;

mod upstream {
    uucore::bin!(uu_sha1sum);
}

fn main() {
    uucore::checksum::stdio::initialize();
    cwd::initialize("sha1sum");
    upstream::main();
}
