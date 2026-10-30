#[cfg(not(target_os = "wasi"))]
pub use std::io::{stdin, stdout};

#[cfg(not(target_os = "wasi"))]
pub fn initialize() {}

#[cfg(target_os = "wasi")]
mod wasi {
    use std::io::{self, Read, Write};
    use std::sync::OnceLock;

    #[repr(C)]
    struct Iovec {
        buffer: *mut u8,
        length: usize,
    }

    #[repr(C)]
    struct Fdstat {
        filetype: u8,
        flags: u16,
        rights_base: u64,
        rights_inheriting: u64,
    }

    static INITIAL_ERRORS: OnceLock<[u16; 2]> = OnceLock::new();

    #[link(wasm_import_module = "wasi_snapshot_preview1")]
    unsafe extern "C" {
        fn fd_fdstat_get(fd: u32, stat: *mut Fdstat) -> u16;
        fn fd_read(fd: u32, vectors: *const Iovec, count: usize, read: *mut usize) -> u16;
        fn fd_write(fd: u32, vectors: *const Iovec, count: usize, written: *mut usize) -> u16;
    }

    fn descriptor_error(fd: u32) -> u16 {
        let mut stat = Fdstat {
            filetype: 0,
            flags: 0,
            rights_base: 0,
            rights_inheriting: 0,
        };
        // fd_fdstat_get initializes only this live ABI-sized result structure.
        unsafe { fd_fdstat_get(fd, &mut stat) }
    }

    pub fn initialize() {
        INITIAL_ERRORS.get_or_init(|| [descriptor_error(0), descriptor_error(1)]);
    }

    fn selected_descriptor(fd: usize) -> io::Result<()> {
        let errors = INITIAL_ERRORS
            .get()
            .expect("checksum stdio initialized before opening files");
        result(errors[fd], 0).map(|_| ())
    }

    pub struct Stdin;
    pub struct Stdout;

    pub fn stdin() -> Stdin {
        Stdin
    }

    pub fn stdout() -> Stdout {
        Stdout
    }

    fn result(errno: u16, count: usize) -> io::Result<usize> {
        if errno != 0 {
            return Err(io::Error::from_raw_os_error(i32::from(errno)));
        }
        Ok(count)
    }

    impl Read for Stdin {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            selected_descriptor(0)?;
            let vector = Iovec {
                buffer: buffer.as_mut_ptr(),
                length: buffer.len(),
            };
            let mut count = 0;
            // The writable slice and count remain live throughout this synchronous WASI call.
            let errno = unsafe { fd_read(0, &vector, 1, &mut count) };
            result(errno, count)
        }
    }

    impl crate::display::OsWrite for Stdout {}

    impl Write for Stdout {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            selected_descriptor(1)?;
            let vector = Iovec {
                buffer: buffer.as_ptr().cast_mut(),
                length: buffer.len(),
            };
            let mut count = 0;
            // fd_write only reads the immutable slice, despite the shared ABI pointer shape.
            let errno = unsafe { fd_write(1, &vector, 1, &mut count) };
            result(errno, count)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
}

#[cfg(target_os = "wasi")]
pub use wasi::{Stdin, initialize, stdin, stdout};
