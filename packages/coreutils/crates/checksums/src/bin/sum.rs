#[path = "../cwd.rs"]
mod cwd;

mod upstream {
    uucore::bin!(uu_sum);
}

fn main() {
    uucore::checksum::stdio::initialize();
    cwd::initialize("sum");
    upstream::main();
}
