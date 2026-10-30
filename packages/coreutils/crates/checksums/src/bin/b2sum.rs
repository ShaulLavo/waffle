#[path = "../cwd.rs"]
mod cwd;

mod upstream {
    uucore::bin!(uu_b2sum);
}

fn main() {
    cwd::initialize("b2sum");
    upstream::main();
}
