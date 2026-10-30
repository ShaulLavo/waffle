#[path = "../cwd.rs"]
mod cwd;

mod upstream {
    uucore::bin!(uu_md5sum);
}

fn main() {
    cwd::initialize("md5sum");
    upstream::main();
}
