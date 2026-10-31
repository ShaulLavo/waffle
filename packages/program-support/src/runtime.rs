//! Minimal guest reactor over runtime_proc descriptors and a preview1 root.
//! Shell process groups, spawning, job reaping and input pumps stay in Bash.
use crate::io::{
    DescriptorKind, Endpoint, FdTable, FileSystem, HostEndpoint, IoError, OpenOptions,
};
use futures::{FutureExt, future::LocalBoxFuture};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    rc::Rc,
    task::{Context, Poll, Waker},
};

#[cfg(all(target_os = "wasi", feature = "cooperative-wasi"))]
mod wasi;
#[cfg(all(target_os = "wasi", feature = "cooperative-wasi"))]
pub use wasi::WasiAbi;

const AGAIN: i32 = 6;
#[cfg(all(target_os = "wasi", feature = "cooperative-wasi"))]
const SIGNAL_DISPOSITION_HANDLE: i32 = 2;

#[cfg(all(target_os = "wasi", feature = "cooperative-wasi"))]
fn decode_descriptor_kind(kind: u32) -> DescriptorKind {
    match kind {
        1 => DescriptorKind::Pipe,
        2 => DescriptorKind::Terminal,
        3 => DescriptorKind::Regular,
        4 => DescriptorKind::Directory,
        _ => DescriptorKind::Other,
    }
}

#[cfg(all(target_os = "wasi", feature = "cooperative-wasi"))]
fn register_interrupt_handler(signal: impl FnOnce(i32, i32) -> i32) -> Result<(), i32> {
    match signal(2, SIGNAL_DISPOSITION_HANDLE) {
        result if result < 0 => Err(-result),
        _ => Ok(()),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Subscription {
    pub kind: u32,
    pub id: u32,
    pub userdata: u64,
}

impl Subscription {
    pub fn encode(self) -> [u8; 16] {
        let mut bytes = [0; 16];
        bytes[..4].copy_from_slice(&self.kind.to_le_bytes());
        bytes[4..8].copy_from_slice(&self.id.to_le_bytes());
        bytes[8..].copy_from_slice(&self.userdata.to_le_bytes());
        bytes
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PollEvent {
    pub userdata: u64,
    pub kind: u32,
    pub flags: u32,
}

impl PollEvent {
    pub fn decode(bytes: [u8; 16]) -> Self {
        Self {
            userdata: u64::from_le_bytes(bytes[..8].try_into().unwrap()),
            kind: u32::from_le_bytes(bytes[8..12].try_into().unwrap()),
            flags: u32::from_le_bytes(bytes[12..].try_into().unwrap()),
        }
    }
}

/// Guest operations required by cooperative programs, with positive WASI errnos.
pub trait Abi {
    fn inherited_fds(&self) -> Vec<u32>;
    fn pipe(&self) -> Result<(u32, u32), i32>;
    fn fd_kind(&self, fd: u32) -> Result<DescriptorKind, i32>;
    fn dup(&self, fd: u32) -> Result<u32, i32>;
    fn close(&self, fd: u32);
    fn mkdir(&self, path: &str, allow_existing: bool) -> Result<(), i32>;
    fn open(&self, path: &str, options: &OpenOptions) -> Result<u32, i32>;
    fn read(&self, fd: u32, output: &mut [u8]) -> Result<usize, i32>;
    fn write(&self, fd: u32, input: &[u8]) -> Result<usize, i32>;
    fn poll(
        &self,
        subscriptions: &[Subscription],
        timeout: i32,
        output: &mut [PollEvent],
    ) -> Result<usize, i32>;
    fn interrupted(&self) -> i32;
}

struct Waiter {
    kind: u32,
    id: u32,
    waker: Waker,
}

struct State {
    abi: Rc<dyn Abi>,
    waiters: RefCell<BTreeMap<u64, Waiter>>,
    next_waiter: Cell<u64>,
    inherited_transferred: Cell<bool>,
}

#[derive(Clone)]
pub struct Runtime(Rc<State>);

impl Runtime {
    pub fn new(abi: Rc<dyn Abi>) -> Self {
        Self(Rc::new(State {
            abi,
            waiters: RefCell::new(BTreeMap::new()),
            next_waiter: Cell::new(1),
            inherited_transferred: Cell::new(false),
        }))
    }

    pub fn endpoint(&self, fd: u32) -> Endpoint {
        Endpoint::host(Rc::new(RuntimeEndpoint {
            runtime: self.clone(),
            fd,
        }))
    }

    pub fn stdio(&self) -> Result<FdTable, IoError> {
        if self.0.inherited_transferred.get() {
            return Err(IoError::BadDescriptor);
        }
        let mut fds = FdTable::default();
        for fd in self.0.abi.inherited_fds() {
            fds.insert(fd, self.endpoint(self.0.abi.dup(fd).map_err(io_error)?));
        }
        Ok(fds)
    }

    pub fn take_stdio(&self) -> Result<FdTable, IoError> {
        let fds = self.stdio()?;
        self.0.inherited_transferred.set(true);
        for fd in self.0.abi.inherited_fds() {
            self.0.abi.close(fd);
        }
        Ok(fds)
    }

    pub fn ready(&self, kind: u32, id: u32) -> Ready {
        Ready {
            runtime: self.clone(),
            kind,
            id,
            token: None,
        }
    }

    /// Poll only between executor turns, never inside a guest task.
    pub fn poll(&self, timeout: i32) -> Result<usize, i32> {
        let subscriptions: Vec<_> = self
            .0
            .waiters
            .borrow()
            .iter()
            .map(|(&token, waiter)| Subscription {
                kind: waiter.kind,
                id: waiter.id,
                userdata: token,
            })
            .collect();
        let mut events = vec![PollEvent::default(); subscriptions.len()];
        let count = self.0.abi.poll(&subscriptions, timeout, &mut events)?;
        if count > events.len() {
            return Err(28);
        }
        let mut wakers = Vec::new();
        {
            let mut waiters = self.0.waiters.borrow_mut();
            for event in events.into_iter().take(count) {
                if waiters
                    .get(&event.userdata)
                    .is_some_and(|waiter| waiter.kind == event.kind)
                    && let Some(waiter) = waiters.remove(&event.userdata)
                {
                    wakers.push(waiter.waker);
                }
            }
        }
        for waker in wakers {
            waker.wake();
        }
        Ok(count)
    }

    pub fn take_interrupt(&self) -> bool {
        self.0.abi.interrupted() == 2
    }
}

pub struct Ready {
    runtime: Runtime,
    kind: u32,
    id: u32,
    token: Option<u64>,
}

impl Future for Ready {
    type Output = ();

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        let this = self.get_mut();
        if let Some(token) = this.token {
            let mut waiters = this.runtime.0.waiters.borrow_mut();
            match waiters.get_mut(&token) {
                None => return Poll::Ready(()),
                Some(waiter) => waiter.waker = cx.waker().clone(),
            }
        } else {
            let token = this.runtime.0.next_waiter.get();
            this.runtime
                .0
                .next_waiter
                .set(token.checked_add(1).expect("reactor token exhausted"));
            this.runtime.0.waiters.borrow_mut().insert(
                token,
                Waiter {
                    kind: this.kind,
                    id: this.id,
                    waker: cx.waker().clone(),
                },
            );
            this.token = Some(token);
        }
        Poll::Pending
    }
}

impl Drop for Ready {
    fn drop(&mut self) {
        if let Some(token) = self.token {
            self.runtime.0.waiters.borrow_mut().remove(&token);
        }
    }
}

struct RuntimeEndpoint {
    runtime: Runtime,
    fd: u32,
}

impl Drop for RuntimeEndpoint {
    fn drop(&mut self) {
        self.runtime.0.abi.close(self.fd);
    }
}

impl HostEndpoint for RuntimeEndpoint {
    fn runtime_fd(&self) -> Option<u32> {
        Some(self.fd)
    }

    fn descriptor_kind(&self) -> Result<DescriptorKind, IoError> {
        self.runtime.0.abi.fd_kind(self.fd).map_err(io_error)
    }

    fn read<'a>(&'a self, output: &'a mut [u8]) -> LocalBoxFuture<'a, Result<usize, IoError>> {
        async move {
            loop {
                match self.runtime.0.abi.read(self.fd, output) {
                    Err(AGAIN) => self.runtime.ready(0, self.fd).await,
                    result => return result.map_err(io_error),
                }
            }
        }
        .boxed_local()
    }

    fn write<'a>(&'a self, input: &'a [u8]) -> LocalBoxFuture<'a, Result<usize, IoError>> {
        async move {
            loop {
                match self.runtime.0.abi.write(self.fd, input) {
                    Err(AGAIN) => self.runtime.ready(1, self.fd).await,
                    result => return result.map_err(io_error),
                }
            }
        }
        .boxed_local()
    }
}

impl FileSystem for Runtime {
    fn mkdir<'a>(
        &'a self,
        path: &'a str,
        parents: bool,
    ) -> LocalBoxFuture<'a, Result<(), IoError>> {
        async move {
            if !path.starts_with('/')
                || path.len() > crate::io::MAX_PATH_BYTES
                || path.contains('\0')
            {
                return Err(IoError::InvalidPath);
            }
            if parents {
                for (index, _) in path.match_indices('/').filter(|(index, _)| *index > 0) {
                    crate::executor::yield_now().await;
                    self.0.abi.mkdir(&path[..index], true).map_err(io_error)?;
                }
            }
            crate::executor::yield_now().await;
            self.0.abi.mkdir(path, parents).map_err(io_error)
        }
        .boxed_local()
    }

    fn pipe(&self) -> Result<(Endpoint, Endpoint), IoError> {
        let (read, write) = self.0.abi.pipe().map_err(io_error)?;
        Ok((self.endpoint(read), self.endpoint(write)))
    }

    fn open<'a>(
        &'a self,
        path: &'a str,
        options: &'a OpenOptions,
    ) -> LocalBoxFuture<'a, Result<Endpoint, IoError>> {
        async move {
            self.0
                .abi
                .open(path, options)
                .map(|fd| self.endpoint(fd))
                .map_err(io_error)
        }
        .boxed_local()
    }
}

pub fn io_error(errno: i32) -> IoError {
    match errno {
        8 | 76 => IoError::BadDescriptor,
        64 => IoError::BrokenPipe,
        44 => IoError::NotFound,
        54 => IoError::NotDirectory,
        58 => IoError::Unsupported,
        28 | 37 => IoError::InvalidPath,
        33 | 48 | 51 => IoError::LimitExceeded,
        _ => IoError::Runtime(errno),
    }
}
