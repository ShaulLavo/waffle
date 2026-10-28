use std::sync::atomic::{AtomicI32, Ordering};

static CLOSED_WRITE: AtomicI32 = AtomicI32::new(0);

uucore::bin_inner!(uu_echo, {
    if let Err(error) = std::io::Write::flush(&mut std::io::stdout()) {
        eprintln!("Error flushing stdout: {error}");
    }
    let errno = CLOSED_WRITE.load(Ordering::Relaxed);
    if errno != 0 {
        eprintln!(
            "echo: write error: {}",
            std::io::Error::from_raw_os_error(errno)
        );
        std::process::exit(1);
    }
});

#[cfg(target_os = "wasi")]
#[repr(C)]
struct IoVec {
    pointer: *const u8,
    length: usize,
}

#[cfg(target_os = "wasi")]
#[unsafe(no_mangle)]
unsafe extern "C" fn __wrap___wasi_fd_write(
    fd: u32,
    iovs: *const IoVec,
    count: usize,
    written: *mut usize,
) -> u16 {
    unsafe extern "C" {
        fn __real___wasi_fd_write(
            fd: u32,
            iovs: *const IoVec,
            count: usize,
            written: *mut usize,
        ) -> u16;
    }
    let result = unsafe { __real___wasi_fd_write(fd, iovs, count, written) };
    if fd == 1
        && result == 8
        && count > 0
        && unsafe { std::slice::from_raw_parts(iovs, count) }
            .iter()
            .any(|iov| iov.length > 0)
    {
        CLOSED_WRITE.store(8, Ordering::Relaxed);
    }
    result
}
