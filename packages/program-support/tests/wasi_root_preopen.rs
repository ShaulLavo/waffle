#[cfg(target_os = "wasi")]
fn main() {
    use waffle_program_support::runtime::WasiAbi;

    #[link(wasm_import_module = "wasi_snapshot_preview1")]
    unsafe extern "C" {
        fn fd_fdstat_get(fd: u32, output: *mut u8) -> u16;
    }

    let abi = WasiAbi::with_inherited_fds(vec![0, 1, 2]).unwrap();
    let root = abi.root_preopen();
    assert_eq!(root, 4); // The runner provides a non-root preopen at fd 3.
    assert_eq!(abi.root_preopen(), root);
    let mut stat = [0; 24];
    assert_eq!(unsafe { fd_fdstat_get(root, stat.as_mut_ptr()) }, 0);
    assert_eq!(stat[0], 3); // Preview1 directory filetype.
}

#[cfg(not(target_os = "wasi"))]
fn main() {}
