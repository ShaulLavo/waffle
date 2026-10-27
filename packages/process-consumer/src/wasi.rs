use super::{DescriptorBinding, Error, Outcome, Request, decode_host_result, validate_path};
use std::io::Write;

#[link(wasm_import_module = "shell_terminal")]
unsafe extern "C" {
    #[link_name = "inherited_fd"]
    fn shell_inherited_fd(index: u32) -> i32;
}

/// Enumerate the delivered Shell worker's actual launch bindings, excluding private
/// preopens. Requires `shell_terminal.inherited_fd`; generic Waffle workers do not
/// provide that namespace. This enumerates bindings, never a guessed fd range.
pub fn inherited_shell_descriptors() -> Result<Vec<DescriptorBinding>, Error> {
    let mut bindings = Vec::new();
    for index in 0..=0x7fff_ffff {
        let fd = unsafe { shell_inherited_fd(index) };
        if fd == -1 {
            return Ok(bindings);
        }
        let fd = u32::try_from(fd).map_err(|_| Error::InvalidRecord)?;
        bindings.push(DescriptorBinding::inherit(fd));
    }
    Err(Error::InvalidRecord)
}

mod imports {
    #[link(wasm_import_module = "runtime_proc")]
    unsafe extern "C" {
        pub(super) fn spawn(ptr: *const u8, length: usize) -> i32;
        pub(super) fn job_of(pid: u32) -> i32;
        pub(super) fn wait(pid: u32, output: *mut u8) -> i32;
        pub(super) fn wait_job(job: u32, flags: u32, output: *mut u8) -> i32;
        pub(super) fn kill(pid: u32, signal: i32) -> i32;
        pub(super) fn kill_job(job: u32, signal: i32) -> i32;
        pub(super) fn poll(ptr: *const u8, count: usize, timeout: i32, output: *mut u8) -> i32;
        pub(super) fn interrupted() -> i32;
        pub(super) fn fd_kind(fd: u32) -> i32;
        pub(super) fn access_start(
            path: *const u8,
            length: usize,
            cwd: *const u8,
            cwd_len: usize,
            mode: i32,
        ) -> i32;
        pub(super) fn access_take(request: u32) -> i32;
        pub(super) fn access_cancel(request: u32) -> i32;
    }
}

/// Preserve open stdio only. Extra descriptors require explicit bindings from the caller.
/// P has no general inherited-descriptor enumeration import.
pub fn inherited_stdio() -> Result<Vec<DescriptorBinding>, Error> {
    let mut bindings = Vec::new();
    for fd in 0..=2 {
        match decode_host_result("fd_kind", unsafe { imports::fd_kind(fd) }) {
            Ok(_) => bindings.push(DescriptorBinding::inherit(fd)),
            Err(Error::Host { errno: 8, .. }) => (),
            Err(error) => return Err(error),
        }
    }
    Ok(bindings)
}

/// Run a child and wait for its whole owned job's descriptor/filesystem safety fence.
/// Waffle owns fatal-caller cleanup even when guest destructors cannot run.
pub fn run(request: &Request) -> Result<Outcome, Error> {
    spawn(request)?.wait()
}

/// Retains the exact supplied bindings synchronously, before returning a child.
/// No module is loaded until the caller actually calls this function.
pub fn spawn(request: &Request) -> Result<Child, Error> {
    let bytes = request.encode()?;
    let pid = decode_host_result("spawn", unsafe {
        imports::spawn(bytes.as_ptr(), bytes.len())
    })?;
    if pid == 0 {
        return Err(Error::InvalidRecord);
    }
    // Install cleanup ownership before the next host call can fail.
    let mut child = Child {
        pid,
        job: None,
        outcome: None,
        complete: false,
    };
    let job = decode_host_result("job_of", unsafe { imports::job_of(pid) })?;
    if job == 0 {
        return Err(Error::InvalidRecord);
    }
    child.job = Some(job);
    Ok(child)
}

/// One child and an independent job. Drop attempts cleanup on a best-effort basis.
/// Blocking waits use Waffle's signal-preserving physical-retirement fence.
/// Use `cancel` explicitly when the caller needs to observe cleanup errors.
/// Waffle owns cancellation and collection when a caller terminates fatally.
#[derive(Debug)]
#[must_use = "a spawned child must be waited for or canceled"]
pub struct Child {
    pid: u32,
    job: Option<u32>,
    outcome: Option<Outcome>,
    complete: bool,
}
impl Child {
    pub fn pid(&self) -> u32 {
        self.pid
    }
    /// Nonblocking. A cached outcome is returned only after the entire job is safe.
    pub fn try_wait(&mut self) -> Result<Option<Outcome>, Error> {
        if self.complete {
            return Ok(self.outcome);
        }
        if self.outcome.is_none() {
            self.outcome = wait_child(self.pid)?;
        }
        let Some(outcome) = self.outcome else {
            return Ok(None);
        };
        let Some(job) = self.job else {
            self.complete = true;
            return Ok(Some(outcome));
        };
        if wait_record("wait_job", |out| unsafe { imports::wait_job(job, 1, out) })?.is_none() {
            return Ok(None);
        }
        self.complete = true;
        Ok(Some(outcome))
    }
    /// A handled signal cancels the owned job with SIGKILL and returns Interrupted
    /// after physical retirement. Other pending handled signals remain untouched.
    pub fn wait(&mut self) -> Result<Outcome, Error> {
        if self.complete {
            return self.outcome.ok_or(Error::InvalidRecord);
        }
        loop {
            if let Some(signal) = take_signal()? {
                self.cancel()?;
                return Err(Error::Interrupted(signal));
            }
            if self.outcome.is_none() {
                self.outcome = wait_child(self.pid)?;
            }
            if self.outcome.is_some() {
                return self.collect_job();
            }
            self.park()?;
        }
    }
    /// SIGKILL the owned job, then wait for descriptor, filesystem and worker cleanup.
    /// Repeated calls return the cached outcome without signaling recycled identities.
    pub fn cancel(&mut self) -> Result<Outcome, Error> {
        if self.complete {
            return self.outcome.ok_or(Error::InvalidRecord);
        }
        let (operation, result) = match self.job {
            Some(job) => ("kill_job", unsafe { imports::kill_job(job, 9) }),
            None => ("kill", unsafe { imports::kill(self.pid, 9) }),
        };
        decode_host_result(operation, result)?;
        self.collect_job()
    }
    fn collect_job(&mut self) -> Result<Outcome, Error> {
        let job = self.job.ok_or(Error::InvalidRecord)?;
        let outcome = wait_record("wait_job", |out| unsafe { imports::wait_job(job, 2, out) })?
            .ok_or(Error::InvalidRecord)?;
        self.outcome = Some(self.outcome.unwrap_or(outcome));
        self.complete = true;
        self.outcome.ok_or(Error::InvalidRecord)
    }
    fn park(&self) -> Result<bool, Error> {
        match (self.outcome, self.job) {
            (Some(_), Some(job)) => park(4, job),
            _ => park(2, self.pid),
        }
    }
}
impl Drop for Child {
    fn drop(&mut self) {
        if self.complete {
            return;
        }
        if let Err(error) = self.cancel() {
            let _ = writeln!(
                std::io::stderr().lock(),
                "wasi-process: child {} cleanup failed: {error}",
                self.pid
            );
        }
    }
}

fn wait_child(pid: u32) -> Result<Option<Outcome>, Error> {
    wait_record("wait", |out| unsafe { imports::wait(pid, out) })
}

fn wait_record(
    operation: &'static str,
    call: impl FnOnce(*mut u8) -> i32,
) -> Result<Option<Outcome>, Error> {
    let mut bytes = [0; 8];
    match decode_host_result(operation, call(bytes.as_mut_ptr())) {
        Ok(0) => Outcome::decode(bytes).map(Some),
        Ok(_) => Err(Error::InvalidRecord),
        Err(Error::Host { errno: 6, .. }) => Ok(None),
        Err(error) => Err(error),
    }
}

fn take_signal() -> Result<Option<u8>, Error> {
    let signal = decode_host_result("interrupted", unsafe { imports::interrupted() })?;
    match signal {
        0 => Ok(None),
        1..=64 if signal != 32 && signal != 33 => Ok(Some(
            u8::try_from(signal).map_err(|_| Error::InvalidRecord)?,
        )),
        _ => Err(Error::InvalidRecord),
    }
}

fn park(kind: u32, id: u32) -> Result<bool, Error> {
    let mut subscription = [0; 16];
    subscription[..4].copy_from_slice(&kind.to_le_bytes());
    subscription[4..8].copy_from_slice(&id.to_le_bytes());
    let mut output = [0; 16];
    let count = decode_host_result("poll", unsafe {
        imports::poll(subscription.as_ptr(), 1, -1, output.as_mut_ptr())
    })?;
    if count > 1 {
        return Err(Error::InvalidRecord);
    }
    // With timeout -1 and one subscription, P returns zero only for a pending
    // signal. It has not waited or consumed that delivery. Cleanup cannot retry.
    Ok(count == 1)
}

struct Access(u32);
impl Access {
    fn check(path: &str, cwd: &str) -> Result<(), Error> {
        validate_path(path, false)?;
        let id = decode_host_result("access_start", unsafe {
            imports::access_start(path.as_ptr(), path.len(), cwd.as_ptr(), cwd.len(), 1)
        })?;
        if id == 0 {
            return Err(Error::InvalidRecord);
        }
        let query = Self(id);
        query.wait()
    }
    fn wait(self) -> Result<(), Error> {
        loop {
            if let Some(signal) = take_signal()? {
                return Err(Error::Interrupted(signal));
            }
            let result = unsafe { imports::access_take(self.0) };
            if result == -6 {
                park(5, self.0)?;
                continue;
            }
            // take consumed the query, including an executable-access error.
            std::mem::forget(self);
            return match decode_host_result("access_take", result)? {
                0 => Ok(()),
                _ => Err(Error::InvalidRecord),
            };
        }
    }
}
impl Drop for Access {
    fn drop(&mut self) {
        let result = unsafe { imports::access_cancel(self.0) };
        if let Err(error) = decode_host_result("access_cancel", result) {
            let _ = writeln!(
                std::io::stderr().lock(),
                "wasi-process: executable query cleanup failed: {error}"
            );
        }
    }
}

/// Search with the caller's post-edit PATH, without loading any candidate module.
/// An absent PATH uses /bin:/usr/bin. Empty components mean cwd. A slash bypasses PATH.
/// EACCES wins over missing/non-directory candidates; unrelated host failures stop search.
pub fn resolve_executable(program: &str, path: Option<&str>, cwd: &str) -> Result<String, Error> {
    validate_path(program, false)?;
    validate_path(cwd, true)?;
    if program.contains('/') {
        Access::check(program, cwd)?;
        return Ok(program.to_owned());
    }
    let path = path.unwrap_or("/bin:/usr/bin");
    if path.contains('\0') || path.len() > super::MAX_REQUEST_BYTES {
        return Err(Error::InvalidInput("invalid PATH"));
    }
    let mut denied = false;
    for directory in path.split(':') {
        let candidate = if directory.is_empty() {
            program.to_owned()
        } else {
            format!("{directory}/{program}")
        };
        match Access::check(&candidate, cwd) {
            Ok(()) => return Ok(candidate),
            Err(Error::Host { errno: 2, .. }) => denied = true,
            Err(Error::Host { errno: 44 | 54, .. }) => (),
            Err(error) => return Err(error),
        }
    }
    Err(Error::Host {
        operation: "access_take",
        errno: if denied { 2 } else { 44 },
    })
}
