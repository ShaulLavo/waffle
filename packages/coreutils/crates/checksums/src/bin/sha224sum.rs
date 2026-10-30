#[path = "../cwd.rs"]
mod cwd;

mod upstream {
    uucore::bin!(uu_sha224sum);
}

fn main() {
    cwd::initialize("sha224sum");
    upstream::main();
}
