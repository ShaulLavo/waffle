#[path = "../cwd.rs"]
mod cwd;

mod upstream {
    uucore::bin!(uu_cksum);
}

fn main() {
    uucore::checksum::stdio::initialize();
    cwd::initialize("cksum");
    upstream::main();
}
