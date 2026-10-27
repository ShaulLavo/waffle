//! WASI links for the neutral guest reactor without a Bash worker import.
use super::*;

#[link(wasm_import_module = "runtime_proc")]
unsafe extern "C" {
    #[link_name = "pipe"]
    fn proc_pipe(output: *mut u8) -> i32;
    #[link_name = "fd_kind"]
    fn proc_fd_kind(fd: u32) -> i32;
    #[link_name = "dup"]
    fn proc_dup(fd: u32) -> i32;
    #[link_name = "read"]
    fn proc_read(fd: u32, ptr: *mut u8, length: usize) -> i32;
    #[link_name = "write"]
    fn proc_write(fd: u32, ptr: *const u8, length: usize) -> i32;
    #[link_name = "poll"]
    fn proc_poll(ptr: *const u8, count: usize, timeout: i32, output: *mut u8) -> i32;
    #[link_name = "interrupted"]
    fn proc_interrupted() -> i32;
    #[link_name = "signal"]
    fn proc_signal(signal: i32, disposition: i32) -> i32;
}

// Provisional generic Waffle launch metadata, enabled only by cooperative-wasi.
#[link(wasm_import_module = "waffle_program")]
unsafe extern "C" {
    fn inherited_fd(index: u32) -> i32;
}

#[link(wasm_import_module = "wasi_snapshot_preview1")]
unsafe extern "C" {
    fn fd_close(fd: u32) -> u16;
    fn fd_prestat_get(fd: u32, output: *mut u8) -> u16;
    fn fd_prestat_dir_name(fd: u32, output: *mut u8, length: usize) -> u16;
    fn path_create_directory(fd: u32, path: *const u8, length: usize) -> u16;
    fn path_filestat_get(
        fd: u32,
        flags: u32,
        path: *const u8,
        length: usize,
        output: *mut u8,
    ) -> u16;
    fn path_open(
        fd: u32,
        lookup: u32,
        path: *const u8,
        length: usize,
        oflags: u16,
        rights: u64,
        inheriting: u64,
        fdflags: u16,
        output: *mut u32,
    ) -> u16;
}

fn result(value: i32) -> Result<u32, i32> {
    if value < 0 {
        Err(-value)
    } else {
        Ok(value as u32)
    }
}

pub struct WasiAbi {
    root: u32,
    inherited: Vec<u32>,
}

impl WasiAbi {
    pub fn new() -> Result<Self, i32> {
        let mut inherited = Vec::new();
        for index in 0.. {
            let fd = unsafe { inherited_fd(index) };
            if fd < 0 {
                break;
            }
            inherited.push(fd as u32);
        }
        let last = 3u32.checked_add(inherited.len() as u32).ok_or(28)?;
        for fd in 3..=last {
            let mut stat = [0; 8];
            if unsafe { fd_prestat_get(fd, stat.as_mut_ptr()) } != 0 || stat[0] != 0 {
                continue;
            }
            let length = u32::from_le_bytes(stat[4..8].try_into().unwrap()) as usize;
            if length != 1 {
                continue;
            }
            let mut name = [0];
            if unsafe { fd_prestat_dir_name(fd, name.as_mut_ptr(), 1) } == 0 && name[0] == b'/' {
                return Ok(Self {
                    root: fd,
                    inherited,
                });
            }
        }
        Err(44)
    }

    pub fn handle_interrupts(&self) -> Result<(), i32> {
        register_interrupt_handler(|signal, disposition| unsafe {
            proc_signal(signal, disposition)
        })
    }
}

impl Abi for WasiAbi {
    fn inherited_fds(&self) -> Vec<u32> {
        self.inherited.clone()
    }

    fn pipe(&self) -> Result<(u32, u32), i32> {
        let mut bytes = [0; 8];
        result(unsafe { proc_pipe(bytes.as_mut_ptr()) })?;
        Ok((
            u32::from_le_bytes(bytes[..4].try_into().unwrap()),
            u32::from_le_bytes(bytes[4..].try_into().unwrap()),
        ))
    }

    fn fd_kind(&self, fd: u32) -> Result<DescriptorKind, i32> {
        result(unsafe { proc_fd_kind(fd) }).map(decode_descriptor_kind)
    }

    fn dup(&self, fd: u32) -> Result<u32, i32> {
        result(unsafe { proc_dup(fd) })
    }

    fn close(&self, fd: u32) {
        unsafe {
            fd_close(fd);
        }
    }

    fn mkdir(&self, path: &str, allow_existing: bool) -> Result<(), i32> {
        if !path.starts_with('/') || path.contains('\0') || path.len() > crate::io::MAX_PATH_BYTES {
            return Err(28);
        }
        let path = path.trim_start_matches('/');
        if path.is_empty() {
            return if allow_existing { Ok(()) } else { Err(20) };
        }
        let errno = unsafe { path_create_directory(self.root, path.as_ptr(), path.len()) };
        if errno == 20 && allow_existing {
            let mut stat = [0u8; 64];
            let error = unsafe {
                path_filestat_get(self.root, 1, path.as_ptr(), path.len(), stat.as_mut_ptr())
            };
            if error != 0 {
                return Err(error as i32);
            }
            return if stat[16] == 3 { Ok(()) } else { Err(54) };
        }
        if errno == 0 {
            Ok(())
        } else {
            Err(errno as i32)
        }
    }

    fn open(&self, path: &str, options: &OpenOptions) -> Result<u32, i32> {
        if !path.starts_with('/') || path.contains('\0') || path.len() > crate::io::MAX_PATH_BYTES {
            return Err(28);
        }
        if (!options.read && !options.write)
            || ((options.append || options.truncate) && !options.write)
        {
            return Err(8);
        }
        let descriptor = crate::io::descriptor_number(path);
        let seekable = match descriptor {
            Some(fd) => self.fd_kind(fd)? == DescriptorKind::Regular,
            None => true,
        };
        let path = path.trim_start_matches('/');
        let rights = if seekable { (1u64 << 2) | (1 << 5) } else { 0 }
            | (1 << 21)
            | (1 << 27)
            | if options.read { 1 << 1 } else { 0 }
            | if options.write { 1 << 6 } else { 0 };
        let flags = u16::from(options.create && descriptor.is_none())
            | if options.truncate { 8 } else { 0 };
        let mut fd = 0;
        let errno = unsafe {
            path_open(
                self.root,
                1,
                path.as_ptr(),
                path.len(),
                flags,
                rights,
                0,
                u16::from(options.append),
                &mut fd,
            )
        };
        if errno == 0 {
            Ok(fd)
        } else {
            Err(errno as i32)
        }
    }

    fn read(&self, fd: u32, output: &mut [u8]) -> Result<usize, i32> {
        result(unsafe { proc_read(fd, output.as_mut_ptr(), output.len()) })
            .map(|count| count as usize)
    }

    fn write(&self, fd: u32, input: &[u8]) -> Result<usize, i32> {
        result(unsafe { proc_write(fd, input.as_ptr(), input.len()) }).map(|count| count as usize)
    }

    fn poll(
        &self,
        subscriptions: &[Subscription],
        timeout: i32,
        output: &mut [PollEvent],
    ) -> Result<usize, i32> {
        let input: Vec<_> = subscriptions.iter().map(|sub| sub.encode()).collect();
        let mut bytes = vec![[0; 16]; subscriptions.len()];
        let count = result(unsafe {
            proc_poll(
                input.as_ptr().cast(),
                input.len(),
                timeout,
                bytes.as_mut_ptr().cast(),
            )
        })? as usize;
        if count > output.len() || count > bytes.len() {
            return Err(28);
        }
        for (event, bytes) in output.iter_mut().zip(bytes).take(count) {
            *event = PollEvent::decode(bytes);
        }
        Ok(count)
    }

    fn interrupted(&self) -> i32 {
        unsafe { proc_interrupted() }
    }
}
