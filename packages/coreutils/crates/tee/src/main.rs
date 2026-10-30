extern crate uu_tee as upstream_tee;

#[path = "../../../src/bin/file_operations/mod.rs"]
mod file_operations;

mod uu_tee {
    pub fn uumain(args: impl uucore::Args) -> i32 {
        #[cfg(target_os = "wasi")]
        super::file_operations::initialize_cwd("tee");
        #[cfg(target_os = "wasi")]
        let _stdout_reservation = match reserve_closed_stdout() {
            Ok(reservation) => reservation,
            Err(error) => {
                eprintln!("tee: cannot preserve closed stdout: {error}");
                return 1;
            }
        };
        upstream_tee::uumain(args)
    }

    #[cfg(target_os = "wasi")]
    fn reserve_closed_stdout() -> std::io::Result<Option<std::fs::File>> {
        use rustix::fd::AsRawFd;
        match rustix::fs::fcntl_getfl(rustix::stdio::stdout()) {
            Ok(_) => return Ok(None),
            Err(rustix::io::Errno::BADF) => {}
            Err(error) => return Err(error.into()),
        }
        // Keep output opens from reusing fd1. This real read-only directory
        // rejects writes through the normal filesystem and supervisor path.
        let directory = std::fs::File::open(".")?;
        if directory.as_raw_fd() != 1 {
            return Err(std::io::Error::other("closed stdout was not reserved"));
        }
        Ok(Some(directory))
    }
}

uucore::bin!(uu_tee);
