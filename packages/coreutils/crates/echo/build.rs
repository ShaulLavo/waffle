fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("wasi") {
        println!("cargo:rustc-link-arg-bin=echo=-Wl,--wrap=__wasi_fd_write");
    }
}
