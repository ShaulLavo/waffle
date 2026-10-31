use futures::{FutureExt, future::LocalBoxFuture, task::noop_waker};
use std::{
    cell::{Cell, RefCell},
    future::Future,
    pin::Pin,
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    task::{Context, Poll, Wake},
};
use waffle_program_support::{
    executor::{Cancel, Event, EventWait},
    io::{
        self, DescriptorKind, Endpoint, FileMetadata, FileSystem, HostEndpoint, IoError,
        OpenOptions, WeakEndpoint,
    },
    runtime::{
        Abi, PollEvent, Ready, Runtime, Subscription, decode_descriptor_kind, decode_filestat,
        decode_permissions, io_error,
    },
};

fn complete<T>(future: impl Future<Output = T>) -> T {
    let mut future = Box::pin(future);
    let waker = noop_waker();
    let mut cx = Context::from_waker(&waker);
    for _ in 0..8 {
        if let Poll::Ready(value) = future.as_mut().poll(&mut cx) {
            return value;
        }
    }
    panic!("future did not complete in eight turns");
}

#[derive(Default)]
struct FakeAbi {
    closed: RefCell<Vec<u32>>,
    stat_paths: RefCell<Vec<(String, bool)>>,
    pages: RefCell<Vec<(u64, Vec<u8>)>>,
    directory_calls: Cell<usize>,
    poll_calls: Cell<usize>,
    reads: Cell<usize>,
    ready: Cell<bool>,
}
impl Abi for FakeAbi {
    fn inherited_fds(&self) -> Vec<u32> {
        vec![0, 9, 1_000_000]
    }
    fn pipe(&self) -> Result<(u32, u32), i32> {
        Ok((20, 21))
    }
    fn fd_kind(&self, _: u32) -> Result<DescriptorKind, i32> {
        Ok(DescriptorKind::Pipe)
    }
    fn dup(&self, fd: u32) -> Result<u32, i32> {
        Ok(fd + 10)
    }
    fn close(&self, fd: u32) {
        self.closed.borrow_mut().push(fd);
    }
    fn mkdir(&self, _: &str, _: bool) -> Result<(), i32> {
        Ok(())
    }
    fn stat(&self, path: &str, follow: bool) -> Result<FileMetadata, i32> {
        self.stat_paths.borrow_mut().push((path.into(), follow));
        Ok(decode_filestat(&[0; 64]))
    }
    fn open_dir(&self, path: &str) -> Result<u32, i32> {
        assert_eq!(path, "/dir");
        Ok(77)
    }
    fn read_dir(&self, fd: u32, cookie: u64, output: &mut [u8]) -> Result<usize, i32> {
        assert_eq!(fd, 77);
        self.directory_calls.set(self.directory_calls.get() + 1);
        let pages = self.pages.borrow();
        let Some((_, bytes)) = pages.iter().find(|(start, _)| *start == cookie) else {
            return Ok(0);
        };
        let count = output.len().min(bytes.len());
        output[..count].copy_from_slice(&bytes[..count]);
        Ok(count)
    }
    fn open(&self, _: &str, _: &OpenOptions) -> Result<u32, i32> {
        Ok(88)
    }
    fn read(&self, _: u32, output: &mut [u8]) -> Result<usize, i32> {
        self.reads.set(self.reads.get() + 1);
        if !self.ready.get() {
            return Err(6);
        }
        output[0] = b'x';
        Ok(1)
    }
    fn write(&self, _: u32, input: &[u8]) -> Result<usize, i32> {
        Ok(input.len())
    }
    fn poll(
        &self,
        subscriptions: &[Subscription],
        _: i32,
        output: &mut [PollEvent],
    ) -> Result<usize, i32> {
        self.poll_calls.set(self.poll_calls.get() + 1);
        for (sub, event) in subscriptions.iter().zip(output) {
            *event = PollEvent {
                userdata: sub.userdata,
                kind: sub.kind,
                flags: 0,
            };
        }
        Ok(subscriptions.len())
    }
    fn interrupted(&self) -> i32 {
        0
    }
}

#[test]
fn public_event_and_child_probe_contracts() {
    let event = Event::default();
    let wait: EventWait = event.listen();
    event.notify();
    assert_eq!(wait.now_or_never(), Some(()));
    let probed = Rc::new(Cell::new(0));
    let observed = probed.clone();
    let parent = Cancel::with_probe(Rc::new(move || {
        observed.set(observed.get() + 1);
        true
    }));
    let child = parent.child();
    let passive = child.without_probe();
    assert!(!passive.probe_now());
    assert_eq!(probed.get(), 0);
    assert!(child.probe_now());
    assert!(passive.is_cancelled());
    let parent = Cancel::new();
    let child = parent.child();
    child.cancel();
    assert!(!parent.is_cancelled());
    let child = parent.child();
    let mut parked = Box::pin(child.cancelled());
    let waker = noop_waker();
    let mut cx = Context::from_waker(&waker);
    assert!(parked.as_mut().poll(&mut cx).is_pending());
    parent.cancel();
    assert!(parked.as_mut().poll(&mut cx).is_ready());
}

#[test]
fn weak_observer_does_not_hold_the_last_writer_open() {
    let (reader, writer) = io::pipe();
    let duplicate = writer.clone();
    assert!(writer.same_open(&duplicate));
    let weak: WeakEndpoint = writer.downgrade();
    drop(writer);
    assert!(weak.upgrade().is_some());
    drop(duplicate);
    assert!(weak.upgrade().is_none());
    assert_eq!(complete(reader.read(&mut [0])), Ok(0));
}

struct Host {
    reads: Cell<usize>,
}
impl HostEndpoint for Host {
    fn runtime_fd(&self) -> Option<u32> {
        Some(12)
    }
    fn read<'a>(&'a self, output: &'a mut [u8]) -> LocalBoxFuture<'a, Result<usize, IoError>> {
        Box::pin(async move {
            self.reads.set(self.reads.get() + 1);
            output[0] = b'h';
            Ok(1)
        })
    }
    fn write<'a>(&'a self, _: &'a [u8]) -> LocalBoxFuture<'a, Result<usize, IoError>> {
        Box::pin(async { Err(IoError::BadDescriptor) })
    }
}

#[test]
fn exported_buffers_keep_source_offset_and_exact_capacity_accounting() {
    let mut data = Vec::with_capacity(128);
    data.extend_from_slice(b"abcdef");
    let capacity = data.capacity();
    let endpoint = Endpoint::bytes(data);
    let duplicate = endpoint.clone();
    assert_eq!(endpoint.buffered_input_bytes(), Some(capacity));
    assert_eq!(Endpoint::null().buffered_input_bytes(), None);
    assert!(io::buffered_input_metadata_bytes() > std::mem::size_of::<Endpoint>());
    let source = endpoint.buffered_source();
    assert!(!source.same_open(&endpoint));
    let mut output = [0; 2];
    assert_eq!(complete(source.read(&mut output)), Ok(2));
    assert_eq!(&output, b"ab");
    assert_eq!(complete(duplicate.read(&mut output)), Ok(2));
    assert_eq!(&output, b"cd");
    let host = Endpoint::host(Rc::new(Host {
        reads: Cell::new(0),
    }));
    let weak_host = host.host_owner().unwrap();
    endpoint.export_buffer(&host);
    assert_eq!(duplicate.runtime_fd(), Some(12));
    assert!(endpoint.host_owner().unwrap().ptr_eq(&weak_host));
    drop(host);
    assert!(weak_host.upgrade().is_some());
    assert_eq!(complete(duplicate.read(&mut output)), Ok(1));
    assert_eq!(output[0], b'h');
    assert_eq!(complete(source.read(&mut output)), Ok(2));
    assert_eq!(&output, b"ef");
    drop(duplicate);
    drop(endpoint);
    assert!(weak_host.upgrade().is_none());
    assert_eq!(complete(source.read(&mut output)), Ok(0));
}

#[test]
fn readiness_is_public_cancel_removes_waiters_and_only_poll_drives_the_host() {
    let abi = Rc::new(FakeAbi::default());
    let runtime = Runtime::new(abi.clone());
    let cancel = Cancel::new();
    let endpoint = runtime.endpoint(18);
    let mut output = [0];
    let mut read = Box::pin(endpoint.read_cancelled(&mut output, &cancel));
    let waker = noop_waker();
    let mut cx = Context::from_waker(&waker);
    assert!(read.as_mut().poll(&mut cx).is_pending());
    assert_eq!(runtime.waiter_count(), 1);
    assert_eq!(abi.poll_calls.get(), 0);
    cancel.cancel();
    assert_eq!(
        read.as_mut().poll(&mut cx),
        Poll::Ready(Err(IoError::Cancelled))
    );
    assert_eq!(runtime.waiter_count(), 0);
    drop(read);
    for kind in [2, 4, 5, 6] {
        let mut ready: Ready = runtime.ready(kind, 42);
        assert!(Pin::new(&mut ready).poll(&mut cx).is_pending());
        assert_eq!(runtime.waiter_count(), 1);
        assert_eq!(runtime.poll(0), Ok(1));
        assert_eq!(runtime.waiter_count(), 0);
        assert!(Pin::new(&mut ready).poll(&mut cx).is_ready());
    }
    let ready = runtime.ready(4, 42);
    assert!(ready.now_or_never().is_none());
    assert_eq!(runtime.waiter_count(), 0);
}

thread_local! { static REENTRANT_RUNTIME: RefCell<Option<Runtime>> = const { RefCell::new(None) }; }
struct ReentrantWake(AtomicUsize);
impl Wake for ReentrantWake {
    fn wake(self: Arc<Self>) {
        self.0.fetch_add(1, Ordering::Relaxed);
        REENTRANT_RUNTIME.with(|slot| {
            let runtime = slot.borrow();
            let runtime = runtime.as_ref().unwrap();
            assert_eq!(runtime.waiter_count(), 1);
            runtime.notify(5, 99);
        });
    }
}

#[test]
fn notify_matches_kind_and_id_and_reentrant_wakers_borrow_freely() {
    let runtime = Runtime::new(Rc::new(FakeAbi::default()));
    REENTRANT_RUNTIME.with(|slot| *slot.borrow_mut() = Some(runtime.clone()));
    let wake = Arc::new(ReentrantWake(AtomicUsize::new(0)));
    let waker = std::task::Waker::from(wake.clone());
    let mut cx = Context::from_waker(&waker);
    let mut first = runtime.ready(4, 42);
    let mut duplicate = runtime.ready(4, 42);
    let mut other = runtime.ready(5, 99);
    assert!(Pin::new(&mut first).poll(&mut cx).is_pending());
    let noop = noop_waker();
    let mut noop_cx = Context::from_waker(&noop);
    assert!(Pin::new(&mut duplicate).poll(&mut noop_cx).is_pending());
    assert!(Pin::new(&mut other).poll(&mut noop_cx).is_pending());
    runtime.notify(4, 99);
    assert_eq!(runtime.waiter_count(), 3);
    runtime.notify(4, 42);
    assert_eq!(wake.0.load(Ordering::Relaxed), 1);
    assert_eq!(runtime.waiter_count(), 0);
    assert!(Pin::new(&mut first).poll(&mut cx).is_ready());
    assert!(Pin::new(&mut duplicate).poll(&mut cx).is_ready());
    assert!(Pin::new(&mut other).poll(&mut cx).is_ready());
    REENTRANT_RUNTIME.with(|slot| slot.borrow_mut().take());
}

fn record(cookie: u64, name: &[u8]) -> Vec<u8> {
    let mut bytes = vec![0; 24];
    bytes[..8].copy_from_slice(&cookie.to_le_bytes());
    bytes[16..20].copy_from_slice(&(name.len() as u32).to_le_bytes());
    bytes.extend_from_slice(name);
    bytes
}

#[test]
fn runtime_stat_and_directory_pages_preserve_metadata_cookies_and_lifetime() {
    let abi = Rc::new(FakeAbi::default());
    let mut page = record(11, b"alpha");
    page.extend_from_slice(&record(29, b"beta"));
    page.extend_from_slice(&[0; 8]); // A partial next header must be refetched at cookie 29.
    *abi.pages.borrow_mut() = vec![(0, page), (29, record(1001, b"tail"))];
    let runtime = Runtime::new(abi.clone());
    assert!(complete(FileSystem::stat(&runtime, "/file", false)).is_ok());
    assert_eq!(&*abi.stat_paths.borrow(), &[("/file".into(), false)]);
    assert!(abi.closed.borrow().is_empty());
    assert_eq!(
        complete(FileSystem::stat(&runtime, "relative", true)),
        Err(IoError::InvalidPath)
    );
    let directory = complete(runtime.open_dir("/dir")).unwrap();
    let mut output = [0; 64];
    let first = complete(directory.read_entry(0, &mut output))
        .unwrap()
        .unwrap();
    assert_eq!(&output[first.name], b"alpha");
    let second = complete(directory.read_entry(first.next_cookie, &mut output))
        .unwrap()
        .unwrap();
    assert_eq!(&output[second.name], b"beta");
    assert_eq!(abi.directory_calls.get(), 1);
    let third = complete(directory.read_entry(second.next_cookie, &mut output))
        .unwrap()
        .unwrap();
    assert_eq!(&output[third.name], b"tail");
    assert_eq!(third.next_cookie, 1001);
    assert_eq!(
        complete(directory.read_entry(third.next_cookie, &mut output)),
        Ok(None)
    );
    drop(directory);
    assert_eq!(&*abi.closed.borrow(), &[77]);
}

#[test]
fn directory_rejects_stalled_or_incomplete_records_and_closes_on_cancel() {
    for page in [
        record(0, b"stalled"),
        vec![0; 8],
        record(1, &vec![b'x'; io::MAX_PATH_BYTES + 1]),
    ] {
        let abi = Rc::new(FakeAbi::default());
        *abi.pages.borrow_mut() = vec![(0, page)];
        let runtime = Runtime::new(abi.clone());
        let directory = complete(runtime.open_dir("/dir")).unwrap();
        assert_eq!(
            complete(directory.read_entry(0, &mut [0; 64])),
            Err(IoError::LimitExceeded)
        );
        let cancel = Cancel::new();
        let mut wait =
            Box::pin(cancel.run(async move { directory.read_entry(0, &mut [0; 64]).await }));
        let waker = noop_waker();
        assert!(
            wait.as_mut()
                .poll(&mut Context::from_waker(&waker))
                .is_pending()
        );
        cancel.cancel();
        assert!(
            wait.as_mut()
                .poll(&mut Context::from_waker(&waker))
                .is_ready()
        );
        drop(wait);
        assert_eq!(&*abi.closed.borrow(), &[77]);
    }
}

#[test]
fn neutral_wire_decoders_preserve_native_widths_and_unknown_capabilities() {
    use io::FileKind;
    let mut bytes = [0; 64];
    for (offset, value) in [
        (0, 0x1020_3040_5060_7080u64),
        (8, 0x8090_a0b0_c0d0_e0f0),
        (32, 0x1_0000_0001),
        (40, 123_456_789),
        (48, 987_654_321),
    ] {
        bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    }
    for (wire, kind) in [
        (0, FileKind::Unknown),
        (1, FileKind::BlockDevice),
        (2, FileKind::CharacterDevice),
        (3, FileKind::Directory),
        (4, FileKind::Regular),
        (5, FileKind::Socket),
        (6, FileKind::Socket),
        (7, FileKind::Symlink),
        (255, FileKind::Unknown),
    ] {
        bytes[16] = wire;
        let metadata = decode_filestat(&bytes);
        assert_eq!(metadata.kind, kind);
        assert_eq!(metadata.device, Some(0x1020_3040_5060_7080));
        assert_eq!(metadata.inode, Some(0x8090_a0b0_c0d0_e0f0));
        assert_eq!(metadata.size, 0x1_0000_0001);
        assert_eq!(metadata.accessed_ns, Some(123_456_789));
        assert_eq!(metadata.modified_ns, Some(987_654_321));
        assert_eq!(metadata.mode, None);
        assert_eq!(metadata.uid, None);
        assert_eq!(metadata.gid, None);
        assert_eq!(metadata.readable, None);
        assert_eq!(metadata.writable, None);
        assert_eq!(metadata.executable, None);
        assert_eq!(metadata.owned_by_effective_uid, None);
        assert_eq!(metadata.owned_by_effective_gid, None);
    }
    let mut metadata = decode_filestat(&bytes);
    let mut permissions = [0; 16];
    for (chunk, value) in permissions.chunks_exact_mut(4).zip([0o640u32, 0o777, 4, 6]) {
        chunk.copy_from_slice(&value.to_le_bytes());
    }
    decode_permissions(&mut metadata, &permissions);
    assert_eq!(metadata.mode.unwrap().test(0o400), Some(true));
    assert_eq!(metadata.readable, Some(true));
    assert_eq!(metadata.writable, Some(false));
    assert_eq!(metadata.executable, None);
    assert_eq!(metadata.uid, None);
    for (wire, kind) in [
        (0, DescriptorKind::Other),
        (1, DescriptorKind::Pipe),
        (2, DescriptorKind::Terminal),
        (3, DescriptorKind::Regular),
        (4, DescriptorKind::Directory),
        (99, DescriptorKind::Other),
    ] {
        assert_eq!(decode_descriptor_kind(wire), kind);
    }
    for (errno, expected) in [
        (8, IoError::BadDescriptor),
        (76, IoError::BadDescriptor),
        (64, IoError::BrokenPipe),
        (44, IoError::NotFound),
        (54, IoError::NotDirectory),
        (58, IoError::Unsupported),
        (28, IoError::InvalidPath),
        (37, IoError::InvalidPath),
        (33, IoError::LimitExceeded),
        (48, IoError::LimitExceeded),
        (51, IoError::LimitExceeded),
        (2, IoError::Runtime(2)),
    ] {
        assert_eq!(io_error(errno), expected);
    }
}

#[cfg(feature = "stack-observation")]
#[test]
fn downstream_stack_observation_records_the_real_driver_turn() {
    use waffle_program_support::executor::observation::*;
    reset_stack_observation();
    let executor = waffle_program_support::executor::Executor::new();
    let task = executor.spawn(async {
        let marker = 0u8;
        measure_poll(&marker);
        measure_drop(&marker);
        measure_calls(7);
    });
    assert_eq!(executor.drive(4).pending, 0);
    assert!(task.is_finished());
    let observation = stack_observation();
    assert!(observation.poll_bytes > 0);
    assert!(observation.drop_bytes > 0);
    assert_eq!(observation.calls, 7);
}
