#[path = "../cwd.rs"]
mod cwd;

mod upstream {
    uucore::bin!(uu_sum);
}

fn main() {
    cwd::initialize("sum");
    upstream::main();
}
