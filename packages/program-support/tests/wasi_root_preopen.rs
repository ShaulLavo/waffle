#[cfg(target_os = "wasi")]
fn main() {
    use waffle_program_support::io::FileKind;
    use waffle_program_support::runtime::{Abi, WasiAbi};

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

    let link = abi.stat("/alias", false).unwrap();
    assert_eq!(link.kind, FileKind::Symlink);
    assert_eq!(link.mode.unwrap().bits, 0o777);
    let target = abi.stat("/alias", true).unwrap();
    assert_eq!(target.kind, FileKind::Regular);
    assert_eq!(target.mode.unwrap().bits, 0o640);
}

#[cfg(not(target_os = "wasi"))]
fn main() {}
