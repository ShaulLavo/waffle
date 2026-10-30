#[path = "../cwd.rs"]
mod cwd;

mod upstream {
    uucore::bin!(uu_cksum);
}

fn main() {
    cwd::initialize("cksum");
    upstream::main();
}
