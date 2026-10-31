//! Minimal guest reactor over runtime_proc descriptors and a preview1 root.
//! Shell process groups, spawning, job reaping and input pumps stay in Bash.
use crate::io::{
    DescriptorKind, Endpoint, FdTable, FileMetadata, FileSystem, HostEndpoint, IoError, OpenOptions,
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

/// Decode runtime_proc's append-only descriptor categories, not Preview1 types.
pub fn decode_descriptor_kind(kind: u32) -> DescriptorKind {
    match kind {
        1 => DescriptorKind::Pipe,
        2 => DescriptorKind::Terminal,
        3 => DescriptorKind::Regular,
        4 => DescriptorKind::Directory,
        _ => DescriptorKind::Other,
    }
}

/// Decode preview1's fixed 64-byte filestat record without relying on Rust
/// layout/alignment. Preview1 exposes no Unix mode, owner or effective access
/// information, so those capabilities remain absent rather than guessed.
pub fn decode_filestat(bytes: &[u8; 64]) -> FileMetadata {
    use crate::io::FileKind;
    let u64_at = |offset| u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap());
    FileMetadata {
        kind: match bytes[16] {
            1 => FileKind::BlockDevice,
            2 => FileKind::CharacterDevice,
            3 => FileKind::Directory,
            4 => FileKind::Regular,
            5 | 6 => FileKind::Socket,
            7 => FileKind::Symlink,
            _ => FileKind::Unknown,
        },
        size: u64_at(32),
        mode: None,
        device: Some(u64_at(0)),
        inode: Some(u64_at(8)),
        uid: None,
        gid: None,
        accessed_ns: Some(u64_at(40)),
        modified_ns: Some(u64_at(48)),
        readable: None,
        writable: None,
        executable: None,
        owned_by_effective_uid: None,
        owned_by_effective_gid: None,
    }
}

/// The runtime_fs record is four little-endian u32s, independent of filestat.
pub fn decode_permissions(metadata: &mut FileMetadata, bytes: &[u8; 16]) {
    let word = |offset| u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
    metadata.mode = Some(crate::io::FileMode {
        bits: word(0),
        supported: word(4),
    });
    let access = word(8);
    let supported = word(12);
    let allowed = |bit| (supported & bit != 0).then_some(access & bit != 0);
    metadata.readable = allowed(4);
    metadata.writable = allowed(2);
    metadata.executable = allowed(1);
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
    /// Metadata only: must not allocate descriptors or open the named node.
    fn stat(&self, path: &str, follow_symlinks: bool) -> Result<FileMetadata, i32>;
    /// Incremental directory operations; descriptor ownership stays with Runtime.
    fn open_dir(&self, _path: &str) -> Result<u32, i32> {
        Err(58)
    }
    fn read_dir(&self, _fd: u32, _cookie: u64, _output: &mut [u8]) -> Result<usize, i32> {
        Err(58)
    }
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

    /// Register a readiness wait on its first poll, not at construction.
    /// The embedding owns kind/id meanings and notifies after publishing state.
    pub fn ready(&self, kind: u32, id: u32) -> Ready {
        Ready {
            runtime: self.clone(),
            kind,
            id,
            token: None,
        }
    }

    /// Number of registered readiness waits, without retaining their owners.
    pub fn waiter_count(&self) -> usize {
        self.0.waiters.borrow().len()
    }

    /// Complete matching waits after the embedding updates its own state.
    /// Wakers run only after the waiter registry borrow has been released.
    pub fn notify(&self, kind: u32, id: u32) {
        let wakers: Vec<_> = self
            .0
            .waiters
            .borrow_mut()
            .extract_if(.., |_, waiter| waiter.kind == kind && waiter.id == id)
            .map(|(_, waiter)| waiter.waker)
            .collect();
        for waker in wakers {
            waker.wake();
        }
    }

    /// Dispatch registered waiters only between executor turns, never inside a
    /// guest task. `Endpoint::read_ready` instead uses a single zero-time ABI
    /// observation that neither registers nor dispatches waiters.
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

/// One reactor registration, removed on completion, notification or drop.
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

    fn read_ready(&self) -> Result<bool, IoError> {
        // This is the only waiter-free runtime observation. Runtime::poll is
        // reserved for the between-turn dispatcher and may remove other
        // waiters; this single zero-time subscription never does so.
        let subscriptions = [Subscription {
            kind: 0,
            id: self.fd,
            userdata: 0,
        }];
        let mut events = [PollEvent::default()];
        let count = self
            .runtime
            .0
            .abi
            .poll(&subscriptions, 0, &mut events)
            .map_err(io_error)?;
        match count {
            0 => Ok(false),
            1 if events[0].kind == 0 && events[0].userdata == 0 && events[0].flags & !1 == 0 => {
                Ok(true)
            }
            _ => Err(IoError::Runtime(28)),
        }
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

const DIRECTORY_PAGE_BYTES: usize = crate::io::MAX_PATH_BYTES + 24;

struct DirectoryPage {
    bytes: Vec<u8>,
    used: usize,
    offset: usize,
    cookie: u64,
}

impl DirectoryPage {
    fn new() -> Result<Self, IoError> {
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(DIRECTORY_PAGE_BYTES)
            .map_err(|_| IoError::LimitExceeded)?;
        bytes.resize(DIRECTORY_PAGE_BYTES, 0);
        Ok(Self {
            bytes,
            used: 0,
            offset: 0,
            cookie: 0,
        })
    }
}

enum DirectoryParse {
    Entry(crate::io::DirectoryEntry),
    Tail,
}

struct RuntimeDirectory {
    runtime: Runtime,
    fd: u32,
    page: RefCell<DirectoryPage>,
}

impl RuntimeDirectory {
    fn refill(&self, cookie: u64, page: &mut DirectoryPage) -> Result<(), IoError> {
        let used = self
            .runtime
            .0
            .abi
            .read_dir(self.fd, cookie, &mut page.bytes)
            .map_err(io_error)?;
        if used > page.bytes.len() {
            return Err(IoError::LimitExceeded);
        }
        page.used = used;
        page.offset = 0;
        page.cookie = cookie;
        Ok(())
    }

    fn read(
        &self,
        cookie: u64,
        output: &mut [u8],
    ) -> Result<Option<crate::io::DirectoryEntry>, IoError> {
        let mut page = self.page.borrow_mut();
        loop {
            if page.cookie != cookie || page.offset == page.used {
                self.refill(cookie, &mut page)?;
            }
            if page.used == 0 {
                return Ok(None);
            }
            let parsed = parse_directory_entry(&mut page, cookie, output)?;
            if let DirectoryParse::Entry(entry) = parsed {
                return Ok(Some(entry));
            }
            page.offset = page.used;
        }
    }
}

fn parse_directory_entry(
    page: &mut DirectoryPage,
    cookie: u64,
    output: &mut [u8],
) -> Result<DirectoryParse, IoError> {
    let remaining = page.used - page.offset;
    if remaining < 24 {
        if page.offset == 0 {
            return Err(IoError::LimitExceeded);
        }
        return Ok(DirectoryParse::Tail);
    }
    let header = page.offset;
    let next_cookie = u64::from_le_bytes(page.bytes[header..header + 8].try_into().unwrap());
    let length =
        u32::from_le_bytes(page.bytes[header + 16..header + 20].try_into().unwrap()) as usize;
    let end = (header + 24)
        .checked_add(length)
        .ok_or(IoError::LimitExceeded)?;
    if end > page.used {
        if page.offset == 0 {
            return Err(IoError::LimitExceeded);
        }
        return Ok(DirectoryParse::Tail);
    }
    if next_cookie == cookie || length > output.len() {
        return Err(IoError::LimitExceeded);
    }
    output[..length].copy_from_slice(&page.bytes[header + 24..end]);
    page.offset = end;
    page.cookie = next_cookie;
    Ok(DirectoryParse::Entry(crate::io::DirectoryEntry {
        next_cookie,
        name: 0..length,
    }))
}

impl Drop for RuntimeDirectory {
    fn drop(&mut self) {
        self.runtime.0.abi.close(self.fd);
    }
}
impl crate::io::Directory for RuntimeDirectory {
    fn read_entry<'a>(
        &'a self,
        cookie: u64,
        output: &'a mut [u8],
    ) -> LocalBoxFuture<'a, Result<Option<crate::io::DirectoryEntry>, IoError>> {
        async move {
            crate::executor::yield_now().await;
            self.read(cookie, output)
        }
        .boxed_local()
    }
}
/// Convert a cooperative deadline to the existing millisecond runtime poll
/// timeout. Positive sub-millisecond remainders round up so a live deadline
/// never becomes an accidental zero-time scan.
pub fn poll_timeout(
    runnable: bool,
    next_deadline: Option<std::time::Instant>,
    now: std::time::Instant,
) -> i32 {
    if runnable {
        return 0;
    }
    let Some(deadline) = next_deadline else {
        return -1;
    };
    if deadline <= now {
        return 0;
    }
    let remaining = deadline.duration_since(now);
    let milliseconds = remaining.as_millis();
    let rounded = milliseconds + u128::from(!remaining.subsec_nanos().is_multiple_of(1_000_000));
    rounded.min(i32::MAX as u128) as i32
}

impl FileSystem for Runtime {
    fn open_dir<'a>(
        &'a self,
        path: &'a str,
    ) -> LocalBoxFuture<'a, Result<Rc<dyn crate::io::Directory>, IoError>> {
        async move {
            if !path.starts_with('/')
                || path.len() > crate::io::MAX_PATH_BYTES
                || path.contains('\0')
            {
                return Err(IoError::InvalidPath);
            }
            crate::executor::yield_now().await;
            let page = DirectoryPage::new()?;
            let fd = self.0.abi.open_dir(path).map_err(io_error)?;
            Ok(Rc::new(RuntimeDirectory {
                runtime: self.clone(),
                fd,
                page: RefCell::new(page),
            }) as Rc<dyn crate::io::Directory>)
        }
        .boxed_local()
    }
    fn stat<'a>(
        &'a self,
        path: &'a str,
        follow_symlinks: bool,
    ) -> LocalBoxFuture<'a, Result<FileMetadata, IoError>> {
        async move {
            if !path.starts_with('/')
                || path.len() > crate::io::MAX_PATH_BYTES
                || path.contains('\0')
            {
                return Err(IoError::InvalidPath);
            }
            crate::executor::yield_now().await;
            self.0.abi.stat(path, follow_symlinks).map_err(io_error)
        }
        .boxed_local()
    }
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

/// Translate a positive WASI errno without applying command exit policy.
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

/// The root occupies a free slot after at most one slot per launch binding.
#[cfg(any(test, all(target_os = "wasi", feature = "cooperative-wasi")))]
fn find_root_preopen(
    inherited_count: usize,
    mut is_root: impl FnMut(u32) -> bool,
) -> Result<u32, i32> {
    let count = u32::try_from(inherited_count).map_err(|_| 28)?;
    let last = 3u32.checked_add(count).ok_or(28)?;
    (3..=last).find(|&fd| is_root(fd)).ok_or(44)
}

#[cfg(test)]
mod tests {
    use super::find_root_preopen;

    #[test]
    fn inherited_root_scan_is_bounded_by_binding_count_not_sparse_fd() {
        let inherited = [0, 3, 1_000_000];
        let mut scanned = Vec::new();
        assert_eq!(
            find_root_preopen(inherited.len(), |fd| {
                scanned.push(fd);
                fd == 6
            }),
            Ok(6)
        );
        assert_eq!(scanned, [3, 4, 5, 6]);
        assert_eq!(find_root_preopen(0, |fd| fd == 3), Ok(3));
        assert_eq!(find_root_preopen(300, |fd| fd == 303), Ok(303));
        assert_eq!(find_root_preopen(1, |_| false), Err(44));
        assert_eq!(
            find_root_preopen(usize::MAX, |_| panic!("must not scan overflow")),
            Err(28)
        );
    }
}
#[cfg(test)]
mod timer_readiness_tests {
    use super::*;
    use std::{
        cell::RefCell,
        future::Future,
        pin::Pin,
        rc::Rc,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        task::{Context, Poll, Wake},
        time::{Duration, Instant},
    };

    struct PollCall {
        subscriptions: Vec<Subscription>,
        timeout: i32,
    }

    #[derive(Default)]
    struct WakeCount(AtomicUsize);

    impl Wake for WakeCount {
        fn wake(self: Arc<Self>) {
            self.0.fetch_add(1, Ordering::Relaxed);
        }
    }

    struct FakeAbi {
        calls: RefCell<Vec<PollCall>>,
        result: RefCell<Result<usize, i32>>,
        event: Cell<PollEvent>,
    }

    impl FakeAbi {
        fn new(result: Result<usize, i32>, event: PollEvent) -> Self {
            Self {
                calls: RefCell::new(Vec::new()),
                result: RefCell::new(result),
                event: Cell::new(event),
            }
        }
    }

    impl Abi for FakeAbi {
        fn inherited_fds(&self) -> Vec<u32> {
            Vec::new()
        }

        fn pipe(&self) -> Result<(u32, u32), i32> {
            Ok((1, 2))
        }

        fn fd_kind(&self, _: u32) -> Result<DescriptorKind, i32> {
            Ok(DescriptorKind::Pipe)
        }

        fn dup(&self, fd: u32) -> Result<u32, i32> {
            Ok(fd)
        }

        fn close(&self, _: u32) {}

        fn mkdir(&self, _: &str, _: bool) -> Result<(), i32> {
            Ok(())
        }

        fn stat(&self, _: &str, _: bool) -> Result<FileMetadata, i32> {
            Err(58)
        }

        fn open(&self, _: &str, _: &OpenOptions) -> Result<u32, i32> {
            Ok(3)
        }

        fn read(&self, _: u32, _: &mut [u8]) -> Result<usize, i32> {
            Ok(0)
        }

        fn write(&self, _: u32, input: &[u8]) -> Result<usize, i32> {
            Ok(input.len())
        }

        fn poll(
            &self,
            subscriptions: &[Subscription],
            timeout: i32,
            output: &mut [PollEvent],
        ) -> Result<usize, i32> {
            self.calls.borrow_mut().push(PollCall {
                subscriptions: subscriptions.to_vec(),
                timeout,
            });
            if *self.result.borrow() == Ok(1) {
                output[0] = self.event.get();
            }
            *self.result.borrow()
        }

        fn interrupted(&self) -> i32 {
            0
        }
    }

    #[test]
    fn runtime_endpoint_read_ready_is_single_zero_time_observation() {
        let abi = Rc::new(FakeAbi::new(
            Ok(1),
            PollEvent {
                userdata: 0,
                kind: 0,
                flags: 0,
            },
        ));
        let runtime = Runtime::new(abi.clone());
        let endpoint = runtime.endpoint(17);
        let mut waiter = runtime.ready(4, 99);
        let mut read_waiter = runtime.ready(0, 17);
        let wakes = Arc::new(WakeCount::default());
        let waker = Waker::from(wakes.clone());
        assert_eq!(
            Pin::new(&mut waiter).poll(&mut Context::from_waker(&waker)),
            Poll::Pending
        );
        assert!(
            Pin::new(&mut read_waiter)
                .poll(&mut Context::from_waker(&waker))
                .is_pending()
        );
        assert_eq!(runtime.waiter_count(), 2);
        assert_eq!(endpoint.read_ready(), Ok(true));
        assert_eq!(runtime.waiter_count(), 2);
        assert_eq!(wakes.0.load(Ordering::Relaxed), 0);
        assert!(
            Pin::new(&mut waiter)
                .poll(&mut Context::from_waker(&waker))
                .is_pending()
        );
        assert!(
            Pin::new(&mut read_waiter)
                .poll(&mut Context::from_waker(&waker))
                .is_pending()
        );
        let calls = abi.calls.borrow();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].timeout, 0);
        assert_eq!(
            calls[0].subscriptions,
            vec![Subscription {
                kind: 0,
                id: 17,
                userdata: 0,
            }]
        );
    }

    #[test]
    fn runtime_endpoint_read_ready_accepts_no_event_and_rejects_malformed_events() {
        let no_event = Rc::new(FakeAbi::new(Ok(0), PollEvent::default()));
        assert_eq!(Runtime::new(no_event).endpoint(17).read_ready(), Ok(false));
        let hangup = Rc::new(FakeAbi::new(
            Ok(1),
            PollEvent {
                userdata: 0,
                kind: 0,
                flags: 1,
            },
        ));
        assert_eq!(Runtime::new(hangup).endpoint(17).read_ready(), Ok(true));

        for event in [
            PollEvent {
                userdata: 0,
                kind: 1,
                flags: 0,
            },
            PollEvent {
                userdata: 1,
                kind: 0,
                flags: 0,
            },
            PollEvent {
                userdata: 0,
                kind: 0,
                flags: 2,
            },
        ] {
            let abi = Rc::new(FakeAbi::new(Ok(1), event));
            assert_eq!(
                Runtime::new(abi).endpoint(17).read_ready(),
                Err(IoError::Runtime(28))
            );
        }

        let too_many = Rc::new(FakeAbi::new(Ok(2), PollEvent::default()));
        assert_eq!(
            Runtime::new(too_many).endpoint(17).read_ready(),
            Err(IoError::Runtime(28))
        );
        let failed = Rc::new(FakeAbi::new(Err(76), PollEvent::default()));
        assert_eq!(
            Runtime::new(failed).endpoint(17).read_ready(),
            Err(IoError::BadDescriptor)
        );
    }

    #[test]
    fn poll_timeout_rounds_clamps_and_prioritizes_runnable() {
        let now = Instant::now();
        assert_eq!(poll_timeout(true, Some(now), now), 0);
        assert_eq!(poll_timeout(true, None, now), 0);
        assert_eq!(poll_timeout(false, None, now), -1);
        assert_eq!(poll_timeout(false, Some(now), now), 0);
        assert_eq!(
            poll_timeout(false, Some(now - Duration::from_secs(1)), now),
            0
        );
        assert_eq!(
            poll_timeout(false, Some(now + Duration::from_micros(1)), now),
            1
        );
        assert_eq!(
            poll_timeout(false, Some(now + Duration::from_nanos(1)), now),
            1
        );
        assert_eq!(
            poll_timeout(false, Some(now + Duration::from_millis(1)), now),
            1
        );
        assert_eq!(
            poll_timeout(
                false,
                Some(now + Duration::from_millis(i32::MAX as u64 + 1)),
                now,
            ),
            i32::MAX
        );
    }
}
