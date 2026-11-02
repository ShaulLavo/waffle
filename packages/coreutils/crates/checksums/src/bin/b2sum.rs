#[path = "../cwd.rs"]
mod cwd;

mod upstream {
    uucore::bin!(uu_b2sum);
}

fn main() {
    uucore::checksum::stdio::initialize();
    cwd::initialize("b2sum");
    upstream::main();
}
