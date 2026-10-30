#[path = "../cwd.rs"]
mod cwd;

mod upstream {
    uucore::bin!(uu_sha384sum);
}

fn main() {
    cwd::initialize("sha384sum");
    upstream::main();
}
