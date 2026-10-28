//! Reference-counted open descriptions and exact-byte, bounded asynchronous I/O.
use crate::executor::{Cancel, Event, yield_now};
use futures::future::LocalBoxFuture;
use std::{
    borrow::Cow,
    cell::{Cell, RefCell},
    collections::{BTreeMap, VecDeque},
    rc::Rc,
    time::{SystemTime, UNIX_EPOCH},
};

/// Open-description categories needed by descriptor predicates. This is separate
/// from filesystem node metadata and from Preview1's filetype enum.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DescriptorKind {
    Other,
    Pipe,
    Terminal,
    Regular,
    Directory,
}

/// Runtime-backed open descriptions implement notification-driven operations.
/// Neither operation may block the executor; dropped futures must unregister
/// readiness waits. The host endpoint's last Rc drop closes its runtime handle.
pub trait HostEndpoint {
    /// Descriptor in the shared preview1/runtime_proc namespace, when spawnable.
    fn runtime_fd(&self) -> Option<u32> {
        None
    }
    /// Non-consuming observation; must not duplicate or retain an endpoint.
    fn descriptor_kind(&self) -> Result<DescriptorKind, IoError> {
        Ok(DescriptorKind::Other)
    }
    fn read<'a>(&'a self, output: &'a mut [u8]) -> LocalBoxFuture<'a, Result<usize, IoError>>;
    fn write<'a>(&'a self, input: &'a [u8]) -> LocalBoxFuture<'a, Result<usize, IoError>>;
}
/// Live runtime filesystems may await service readiness but must never block an
/// executor task. Callers race opens with their job's cancellation token.
pub trait FileSystem {
    /// Pipeline endpoints must belong to the same host as spawned processes.
    fn pipe(&self) -> Result<(Endpoint, Endpoint), IoError> {
        Ok(pipe())
    }
    /// Create one directory, or missing parents when requested. Runtime-backed
    /// preview1 metadata calls currently share open's documented blocking limit.
    fn mkdir<'a>(&'a self, path: &'a str, parents: bool)
    -> LocalBoxFuture<'a, Result<(), IoError>>;
    /// Inspect the named node without opening it or reading its contents. False
    /// requests lstat semantics (do not follow the final symbolic link). Missing
    /// capabilities must be reported as unsupported, never as a missing file.
    fn stat<'a>(
        &'a self,
        _path: &'a str,
        _follow_symlinks: bool,
    ) -> LocalBoxFuture<'a, Result<FileMetadata, IoError>> {
        Box::pin(async { Err(IoError::Unsupported) })
    }
    /// Open an incremental directory reader, never a directory-sized snapshot.
    /// Dropping the reader closes its host handle, including on cancellation.
    fn open_dir<'a>(
        &'a self,
        _path: &'a str,
    ) -> LocalBoxFuture<'a, Result<Rc<dyn Directory>, IoError>> {
        Box::pin(async { Err(IoError::Unsupported) })
    }
    fn open<'a>(
        &'a self,
        path: &'a str,
        options: &'a OpenOptions,
    ) -> LocalBoxFuture<'a, Result<Endpoint, IoError>>;
}

/// Read one entry into caller-owned storage. Cookie zero starts enumeration;
/// returned cookies are opaque and must make progress on this reader. A buffer
/// of MAX_PATH_BYTES + 24 fits a maximum name and preview1's fixed header.
pub trait Directory {
    fn read_entry<'a>(
        &'a self,
        cookie: u64,
        output: &'a mut [u8],
    ) -> LocalBoxFuture<'a, Result<Option<DirectoryEntry>, IoError>>;
}

/// A borrowed name range in read_entry's caller-owned buffer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectoryEntry {
    pub next_cookie: u64,
    pub name: std::ops::Range<usize>,
}

/// Node types representable by the browser filesystem and WASI preview1.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileKind {
    Regular,
    Directory,
    Symlink,
    BlockDevice,
    CharacterDevice,
    Fifo,
    Socket,
    Unknown,
}
/// Authoritative Unix mode bits. A clear unsupported bit is unknown, not denied.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileMode {
    pub bits: u32,
    pub supported: u32,
}
impl FileMode {
    pub fn test(self, bit: u32) -> Option<bool> {
        (self.supported & bit == bit).then_some(self.bits & bit != 0)
    }
}
/// A metadata snapshot. Optional values are absent when the host cannot report
/// them; callers must not invent permissions, ownership or timestamps from an
/// open succeeding. Access and ownership booleans refer to the effective caller.
/// Timestamps are nanoseconds since the Unix epoch, not elapsed shell time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileMetadata {
    pub kind: FileKind,
    pub size: u64,
    pub mode: Option<FileMode>,
    pub device: Option<u64>,
    pub inode: Option<u64>,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    pub accessed_ns: Option<u64>,
    pub modified_ns: Option<u64>,
    pub readable: Option<bool>,
    pub writable: Option<bool>,
    pub executable: Option<bool>,
    pub owned_by_effective_uid: Option<bool>,
    pub owned_by_effective_gid: Option<bool>,
}

pub const PIPE_CAPACITY: usize = 32 * 1024;
const PIPE_BUF: usize = 4096;
// The fixed-capacity internal pipe must always be able to admit an atomic write.
const _: () = assert!(PIPE_BUF <= PIPE_CAPACITY);
pub const MAX_MEMORY_FILES: usize = 1024;
pub const MAX_PATH_BYTES: usize = 4096;
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IoError {
    BadDescriptor,
    BrokenPipe,
    Cancelled,
    LimitExceeded,
    NotFound,
    AlreadyExists,
    NotDirectory,
    Unsupported,
    InvalidPath,
    WriteZero,
    Runtime(i32),
}
impl IoError {
    pub fn status(&self) -> i32 {
        match self {
            Self::BrokenPipe => 141,
            Self::Cancelled => 130,
            _ => 1,
        }
    }
}
impl std::fmt::Display for IoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if let Self::Runtime(errno) = self {
            return write!(f, "runtime I/O error: errno {errno}");
        }
        f.write_str(match self {
            Self::BadDescriptor => "bad descriptor",
            Self::BrokenPipe => "broken pipe",
            Self::Cancelled => "cancelled",
            Self::LimitExceeded => "I/O memory limit exceeded",
            Self::NotFound => "file not found",
            Self::AlreadyExists => "file exists",
            Self::NotDirectory => "not a directory",
            Self::Unsupported => "filesystem operation unsupported",
            Self::InvalidPath => "invalid path",
            Self::WriteZero => "write made no progress",
            Self::Runtime(_) => unreachable!(),
        })
    }
}
impl std::error::Error for IoError {}
struct PipeState {
    bytes: VecDeque<u8>,
    readers: usize,
    writers: usize,
}
struct Pipe {
    state: RefCell<PipeState>,
    readable: Event,
    writable: Event,
}
fn timestamp_ns() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|time| time.as_nanos().try_into().ok())
}
struct File {
    data: RefCell<Vec<u8>>,
    metadata: Cell<FileMetadata>,
}
impl File {
    fn accessed(&self) {
        let mut metadata = self.metadata.get();
        metadata.accessed_ns = timestamp_ns();
        self.metadata.set(metadata);
    }
    fn modified(&self) {
        let mut metadata = self.metadata.get();
        metadata.modified_ns = timestamp_ns();
        self.metadata.set(metadata);
    }
}
struct FsState {
    directories: BTreeMap<String, FileMetadata>,
    files: BTreeMap<String, Rc<File>>,
    next_inode: u64,
    used: usize,
    limit: usize,
}
impl FsState {
    fn child_created(&mut self, path: &str) {
        if let Some((parent, _)) = path.rsplit_once('/') {
            let parent = if parent.is_empty() { "/" } else { parent };
            if let Some(metadata) = self.directories.get_mut(parent) {
                metadata.modified_ns = timestamp_ns();
            }
        }
    }
    fn metadata(&mut self, kind: FileKind) -> FileMetadata {
        let inode = self.next_inode;
        self.next_inode += 1;
        let time = timestamp_ns();
        // MemoryFs is a single-owner filesystem without chmod or execution of
        // file payloads. Its regular files are readable/writable, not executable;
        // directories are searchable. There is no numeric user/group namespace.
        FileMetadata {
            kind,
            size: 0,
            mode: Some(FileMode {
                bits: if kind == FileKind::Directory {
                    0o777
                } else {
                    0o666
                },
                supported: 0o7777,
            }),
            device: None,
            inode: Some(inode),
            uid: None,
            gid: None,
            accessed_ns: time,
            modified_ns: time,
            readable: Some(true),
            writable: Some(true),
            executable: Some(kind == FileKind::Directory),
            owned_by_effective_uid: Some(true),
            owned_by_effective_gid: Some(true),
        }
    }
}
struct FileOpen {
    file: Rc<File>,
    fs: Rc<RefCell<FsState>>,
    offset: Cell<usize>,
    options: OpenOptions,
}
struct BufferedInput {
    data: Vec<u8>,
    offset: Cell<usize>,
}
impl BufferedInput {
    fn read(&self, output: &mut [u8]) -> usize {
        let start = self.offset.get();
        let count = output
            .len()
            .min(PIPE_CAPACITY)
            .min(self.data.len().saturating_sub(start));
        output[..count].copy_from_slice(&self.data[start..start + count]);
        self.offset.set(start + count);
        count
    }
}
enum Open {
    PipeRead(Rc<Pipe>),
    PipeWrite(Rc<Pipe>),
    File(FileOpen),
    Capture(Rc<CaptureState>),
    /// Read-only bytes (here-documents and here-strings), shared offset.
    Bytes {
        data: Rc<BufferedInput>,
        exported: RefCell<Option<Rc<dyn HostEndpoint>>>,
    },
    Host(Rc<dyn HostEndpoint>),
    Null,
}
impl Drop for Open {
    fn drop(&mut self) {
        match self {
            Self::PipeRead(pipe) => {
                pipe.state.borrow_mut().readers -= 1;
                pipe.writable.notify();
            }
            Self::PipeWrite(pipe) => {
                pipe.state.borrow_mut().writers -= 1;
                pipe.readable.notify();
            }
            _ => {}
        }
    }
}
/// Clones are dup-style references to the SAME open description, including file
/// offsets. A separate filesystem open creates an independent offset.
#[derive(Clone)]
pub struct Endpoint(Rc<Open>);
pub fn pipe() -> (Endpoint, Endpoint) {
    let pipe = Rc::new(Pipe {
        state: RefCell::new(PipeState {
            bytes: VecDeque::with_capacity(PIPE_CAPACITY),
            readers: 1,
            writers: 1,
        }),
        readable: Event::default(),
        writable: Event::default(),
    });
    (
        Endpoint(Rc::new(Open::PipeRead(pipe.clone()))),
        Endpoint(Rc::new(Open::PipeWrite(pipe))),
    )
}
impl Endpoint {
    #[cfg(test)]
    pub(crate) fn same_open(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
    pub fn runtime_fd(&self) -> Option<u32> {
        match self.0.as_ref() {
            Open::Host(host) => host.runtime_fd(),
            Open::Bytes { exported, .. } => exported
                .borrow()
                .as_ref()
                .and_then(|host| host.runtime_fd()),
            _ => None,
        }
    }
    pub fn descriptor_kind(&self) -> Result<DescriptorKind, IoError> {
        match self.0.as_ref() {
            Open::PipeRead(_) | Open::PipeWrite(_) => Ok(DescriptorKind::Pipe),
            Open::Host(host) => host.descriptor_kind(),
            Open::File(_) | Open::Bytes { .. } => Ok(DescriptorKind::Regular),
            Open::Capture(_) | Open::Null => Ok(DescriptorKind::Other),
        }
    }
    pub fn null() -> Self {
        Self(Rc::new(Open::Null))
    }
    pub fn host(endpoint: Rc<dyn HostEndpoint>) -> Self {
        Self(Rc::new(Open::Host(endpoint)))
    }
    /// A read-only endpoint over owned bytes, like bash's here-document
    /// files. Duplicates share the read offset.
    pub fn bytes(data: Vec<u8>) -> Self {
        Self(Rc::new(Open::Bytes {
            data: Rc::new(BufferedInput {
                data,
                offset: Cell::new(0),
            }),
            exported: RefCell::new(None),
        }))
    }
    pub async fn read(&self, output: &mut [u8]) -> Result<usize, IoError> {
        if output.is_empty() {
            return Ok(0);
        }
        match self.0.as_ref() {
            Open::PipeRead(pipe) => loop {
                let ready = pipe.readable.listen();
                let result = {
                    let mut state = pipe.state.borrow_mut();
                    let count = output.len().min(state.bytes.len());
                    if count != 0 {
                        for byte in &mut output[..count] {
                            *byte = state.bytes.pop_front().unwrap();
                        }
                        Some(count)
                    } else if state.writers == 0 {
                        Some(0)
                    } else {
                        None
                    }
                };
                if let Some(count) = result {
                    if count != 0 {
                        pipe.writable.notify();
                    }
                    return Ok(count);
                }
                ready.await;
            },
            Open::File(file) if file.options.read => {
                let data = file.file.data.borrow();
                let offset = file.offset.get();
                let count = output
                    .len()
                    .min(PIPE_CAPACITY)
                    .min(data.len().saturating_sub(offset));
                if count != 0 {
                    output[..count].copy_from_slice(&data[offset..offset + count]);
                    file.offset.set(offset + count);
                }
                file.file.accessed();
                Ok(count)
            }
            Open::Host(endpoint) => endpoint.read(output).await,
            Open::Bytes { data, exported } => {
                let host = exported.borrow().clone();
                match host {
                    Some(host) => host.read(output).await,
                    None => Ok(data.read(output)),
                }
            }
            Open::Null => Ok(0),
            _ => Err(IoError::BadDescriptor),
        }
    }
    pub async fn write(&self, input: &[u8]) -> Result<usize, IoError> {
        if input.is_empty() {
            return Ok(0);
        }
        match self.0.as_ref() {
            Open::PipeWrite(pipe) => loop {
                let ready = pipe.writable.listen();
                let result = {
                    let mut state = pipe.state.borrow_mut();
                    if state.readers == 0 {
                        return Err(IoError::BrokenPipe);
                    }
                    let available = PIPE_CAPACITY - state.bytes.len();
                    // A request within PIPE_BUF is admitted only as a whole. This
                    // is the shell's atomic-write boundary: printf records must not
                    // become partial writes merely because the pipe is under pressure.
                    let count = if input.len() <= PIPE_BUF && available < input.len() {
                        0
                    } else {
                        input.len().min(available)
                    };
                    if count != 0 {
                        state.bytes.extend(&input[..count]);
                        Some(count)
                    } else {
                        None
                    }
                };
                if let Some(count) = result {
                    pipe.readable.notify();
                    return Ok(count);
                }
                ready.await;
            },
            Open::File(file) if file.options.write => {
                let input = &input[..input.len().min(PIPE_CAPACITY)];
                let mut fs = file.fs.borrow_mut();
                let mut data = file.file.data.borrow_mut();
                let offset = if file.options.append {
                    data.len()
                } else {
                    file.offset.get()
                };
                let end = offset
                    .checked_add(input.len())
                    .ok_or(IoError::LimitExceeded)?;
                let growth = end.saturating_sub(data.len());
                if growth > fs.limit - fs.used {
                    return Err(IoError::LimitExceeded);
                }
                if growth > 0 {
                    data.try_reserve_exact(growth)
                        .map_err(|_| IoError::LimitExceeded)?;
                    data.resize(end, 0);
                    fs.used += growth;
                }
                data[offset..end].copy_from_slice(input);
                file.offset.set(end);
                file.file.modified();
                Ok(input.len())
            }
            Open::Capture(capture) => {
                let mut data = capture.bytes.borrow_mut();
                if input.len() > capture.limit - data.len() {
                    return Err(IoError::LimitExceeded);
                }
                let input = &input[..input.len().min(PIPE_CAPACITY)];
                data.try_reserve_exact(input.len())
                    .map_err(|_| IoError::LimitExceeded)?;
                data.extend_from_slice(input);
                Ok(input.len())
            }
            Open::Host(endpoint) => endpoint.write(input).await,
            Open::Null => Ok(input.len()),
            _ => Err(IoError::BadDescriptor),
        }
    }
    pub async fn read_cancelled(
        &self,
        output: &mut [u8],
        cancel: &Cancel,
    ) -> Result<usize, IoError> {
        cancel
            .run(self.read(output))
            .await
            .map_err(|_| IoError::Cancelled)?
    }
    pub async fn write_cancelled(&self, input: &[u8], cancel: &Cancel) -> Result<usize, IoError> {
        cancel
            .run(self.write(input))
            .await
            .map_err(|_| IoError::Cancelled)?
    }
    /// Bounded chunks and explicit yields prevent always-ready sinks from starving
    /// sibling stages. Cancellation never rolls back already-written bytes.
    pub async fn write_all(&self, mut input: &[u8], cancel: &Cancel) -> Result<(), IoError> {
        while !input.is_empty() {
            let chunk = &input[..input.len().min(PIPE_CAPACITY)];
            let count = self.write_cancelled(chunk, cancel).await?;
            if count == 0 || count > chunk.len() {
                return Err(IoError::WriteZero);
            }
            input = &input[count..];
            yield_now().await;
        }
        if cancel.is_cancelled() {
            Err(IoError::Cancelled)
        } else {
            Ok(())
        }
    }
}
#[derive(Clone, Default)]
pub struct FdTable(BTreeMap<u32, Endpoint>);
impl FdTable {
    pub fn get(&self, fd: u32) -> Option<Endpoint> {
        self.0.get(&fd).cloned()
    }
    pub fn insert(&mut self, fd: u32, endpoint: Endpoint) -> Option<Endpoint> {
        self.0.insert(fd, endpoint)
    }
    pub fn remove(&mut self, fd: u32) -> Option<Endpoint> {
        self.0.remove(&fd)
    }
    pub fn iter(&self) -> impl Iterator<Item = (&u32, &Endpoint)> {
        self.0.iter()
    }
}
struct CaptureState {
    bytes: RefCell<Vec<u8>>,
    limit: usize,
}
#[derive(Clone)]
pub struct Capture(Rc<CaptureState>);
impl Capture {
    pub fn bytes(&self) -> Vec<u8> {
        self.0.bytes.borrow().clone()
    }
    pub fn len(&self) -> usize {
        self.0.bytes.borrow().len()
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}
pub fn capture(limit: usize) -> (Endpoint, Capture) {
    let state = Rc::new(CaptureState {
        bytes: RefCell::new(Vec::new()),
        limit,
    });
    (
        Endpoint(Rc::new(Open::Capture(state.clone()))),
        Capture(state),
    )
}
#[derive(Debug, Clone, Copy)]
pub struct OpenOptions {
    pub read: bool,
    pub write: bool,
    pub create: bool,
    pub truncate: bool,
    pub append: bool,
}
impl Default for OpenOptions {
    fn default() -> Self {
        Self {
            read: true,
            write: false,
            create: false,
            truncate: false,
            append: false,
        }
    }
}
/// A shared, byte-limited filesystem for simple redirects. File payload bytes are
/// limited by `total_limit`; file and directory metadata are each capped at MAX_MEMORY_FILES
/// names of MAX_PATH_BYTES each. Paths must already be resolved against the shell's
/// cwd; directory policy belongs to the interpreter.
#[derive(Clone)]
pub struct MemoryFs(Rc<RefCell<FsState>>);
impl MemoryFs {
    pub fn new(total_limit: usize) -> Self {
        let mut state = FsState {
            directories: BTreeMap::new(),
            files: BTreeMap::new(),
            next_inode: 1,
            used: 0,
            limit: total_limit,
        };
        for path in ["/", "/home", "/home/guest", "/tmp"] {
            let metadata = state.metadata(FileKind::Directory);
            state.directories.insert(path.to_owned(), metadata);
        }
        Self(Rc::new(RefCell::new(state)))
    }
    pub fn used_bytes(&self) -> usize {
        self.0.borrow().used
    }
    /// MemoryFs currently has no symlinks, so stat and lstat resolve identically.
    /// Check each traversed directory before resolving `..`; a missing component
    /// must not disappear merely because the following component goes upward.
    pub fn stat(&self, path: &str, _follow_symlinks: bool) -> Result<FileMetadata, IoError> {
        if !path.starts_with('/') || path.len() > MAX_PATH_BYTES || path.contains('\0') {
            return Err(IoError::InvalidPath);
        }
        let fs = self.0.borrow();
        let mut resolved = String::from("/");
        let mut components = path.split('/').filter(|part| !part.is_empty()).peekable();
        while let Some(component) = components.next() {
            match component {
                "." => {}
                ".." => {
                    let index = resolved.rfind('/').unwrap();
                    resolved.truncate(index.max(1));
                }
                _ => {
                    if resolved.len() > 1 {
                        resolved.push('/');
                    }
                    resolved.push_str(component);
                }
            }
            if components.peek().is_some() || path.ends_with('/') {
                if fs.files.contains_key(&resolved) {
                    return Err(IoError::NotDirectory);
                }
                if !fs.directories.contains_key(&resolved) {
                    return Err(IoError::NotFound);
                }
            }
        }
        let mut metadata = if let Some(metadata) = fs.directories.get(&resolved) {
            *metadata
        } else {
            let file = fs.files.get(&resolved).ok_or(IoError::NotFound)?;
            let mut metadata = file.metadata.get();
            metadata.size = file.data.borrow().len() as u64;
            metadata
        };
        metadata.device = Some(Rc::as_ptr(&self.0) as usize as u64);
        Ok(metadata)
    }
    pub fn open(&self, path: &str, options: &OpenOptions) -> Result<Endpoint, IoError> {
        if path.is_empty() || path.len() > MAX_PATH_BYTES || path.contains('\0') {
            return Err(IoError::InvalidPath);
        }
        if (!options.read && !options.write)
            || ((options.truncate || options.append) && !options.write)
        {
            return Err(IoError::BadDescriptor);
        }
        let mut fs = self.0.borrow_mut();
        if fs.directories.contains_key(path) {
            return Err(IoError::AlreadyExists);
        }
        let file = match fs.files.get(path) {
            Some(file) => file.clone(),
            None if options.create => {
                if fs.files.len() >= MAX_MEMORY_FILES {
                    return Err(IoError::LimitExceeded);
                }
                let metadata = fs.metadata(FileKind::Regular);
                let file = Rc::new(File {
                    data: RefCell::new(Vec::new()),
                    metadata: Cell::new(metadata),
                });
                fs.files.insert(path.to_owned(), file.clone());
                fs.child_created(path);
                file
            }
            None => return Err(IoError::NotFound),
        };
        drop(fs);
        memory_file_open(self.0.clone(), file, options)
    }

    pub fn mkdir(&self, path: &str, parents: bool) -> Result<(), IoError> {
        if !path.starts_with('/') || path.len() > MAX_PATH_BYTES || path.contains('\0') {
            return Err(IoError::InvalidPath);
        }
        let path = path.trim_end_matches('/');
        let path = if path.is_empty() { "/" } else { path };
        let mut fs = self.0.borrow_mut();
        let mut create = |directory: &str, allow_existing: bool| {
            if fs.files.contains_key(directory) {
                return Err(IoError::AlreadyExists);
            }
            if fs.directories.contains_key(directory) {
                return if allow_existing {
                    Ok(())
                } else {
                    Err(IoError::AlreadyExists)
                };
            }
            let parent = directory
                .rsplit_once('/')
                .map(|(p, _)| if p.is_empty() { "/" } else { p })
                .unwrap();
            if fs.files.contains_key(parent) {
                return Err(IoError::NotDirectory);
            }
            if !fs.directories.contains_key(parent) {
                return Err(IoError::NotFound);
            }
            if fs.directories.len() >= MAX_MEMORY_FILES {
                return Err(IoError::LimitExceeded);
            }
            let metadata = fs.metadata(FileKind::Directory);
            fs.directories.insert(directory.to_owned(), metadata);
            fs.child_created(directory);
            Ok(())
        };
        if parents {
            for (index, _) in path.match_indices('/').filter(|(index, _)| *index > 0) {
                create(&path[..index], true)?;
            }
        }
        create(path, parents)
    }
    pub fn set_executable(&self, path: &str, executable: bool) -> Result<(), IoError> {
        let file = self
            .0
            .borrow()
            .files
            .get(path)
            .cloned()
            .ok_or(IoError::NotFound)?;
        let mut metadata = file.metadata.get();
        metadata.executable = Some(executable);
        metadata.mode = Some(FileMode {
            bits: if executable { 0o755 } else { 0o600 },
            supported: 0o7777,
        });
        file.metadata.set(metadata);
        Ok(())
    }
    pub fn read_file(&self, path: &str) -> Result<Vec<u8>, IoError> {
        let fs = self.0.borrow();
        let file = fs.files.get(path).ok_or(IoError::NotFound)?;
        let bytes = file.data.borrow().clone();
        file.accessed();
        Ok(bytes)
    }
    pub fn write_file(&self, path: &str, input: &[u8]) -> Result<(), IoError> {
        if path.is_empty() || path.len() > MAX_PATH_BYTES || path.contains('\0') {
            return Err(IoError::InvalidPath);
        }
        let mut fs = self.0.borrow_mut();
        if fs.directories.contains_key(path) {
            return Err(IoError::AlreadyExists);
        }
        let old = fs
            .files
            .get(path)
            .map(|file| file.data.borrow().len())
            .unwrap_or(0);
        if !fs.files.contains_key(path) && fs.files.len() >= MAX_MEMORY_FILES {
            return Err(IoError::LimitExceeded);
        }
        if input.len() > fs.limit - (fs.used - old) {
            return Err(IoError::LimitExceeded);
        }
        let mut data = Vec::new();
        data.try_reserve_exact(input.len())
            .map_err(|_| IoError::LimitExceeded)?;
        data.extend_from_slice(input);
        let file = if let Some(file) = fs.files.get(path) {
            file.clone()
        } else {
            let metadata = fs.metadata(FileKind::Regular);
            let file = Rc::new(File {
                data: RefCell::new(Vec::new()),
                metadata: Cell::new(metadata),
            });
            fs.files.insert(path.to_owned(), file.clone());
            fs.child_created(path);
            file
        };
        *file.data.borrow_mut() = data;
        file.modified();
        fs.used = fs.used - old + input.len();
        Ok(())
    }
}

struct MemoryDirectory {
    fs: MemoryFs,
    path: String,
}
impl Directory for MemoryDirectory {
    fn read_entry<'a>(
        &'a self,
        cookie: u64,
        output: &'a mut [u8],
    ) -> LocalBoxFuture<'a, Result<Option<DirectoryEntry>, IoError>> {
        Box::pin(async move {
            let path = &self.path;
            let fs = self.fs.0.borrow();
            let mut index = 0u64;
            // Each map is independently capped at MAX_MEMORY_FILES. This bounded
            // scan owns no collection and returns only one copied basename.
            for candidate in fs.directories.keys().chain(fs.files.keys()) {
                let Some((parent, name)) = candidate.rsplit_once('/') else {
                    continue;
                };
                let parent = if parent.is_empty() { "/" } else { parent };
                if parent != path.as_str() || name.is_empty() {
                    continue;
                }
                if index == cookie {
                    if name.len() > output.len() {
                        return Err(IoError::LimitExceeded);
                    }
                    output[..name.len()].copy_from_slice(name.as_bytes());
                    return Ok(Some(DirectoryEntry {
                        next_cookie: index + 1,
                        name: 0..name.len(),
                    }));
                }
                index += 1;
            }
            Ok(None)
        })
    }
}
impl FileSystem for MemoryFs {
    fn open_dir<'a>(
        &'a self,
        path: &'a str,
    ) -> LocalBoxFuture<'a, Result<Rc<dyn Directory>, IoError>> {
        Box::pin(async move {
            if self.stat(path, true)?.kind != FileKind::Directory {
                return Err(IoError::NotDirectory);
            }
            // Validate traversal before lexical normalization of missing/.. .
            // One bounded buffer, rather than absolute()'s component snapshots.
            let mut resolved = String::new();
            resolved
                .try_reserve_exact(path.len().max(1))
                .map_err(|_| IoError::LimitExceeded)?;
            resolved.push('/');
            for component in path.split('/') {
                match component {
                    "" | "." => {}
                    ".." => {
                        let index = resolved.rfind('/').unwrap();
                        resolved.truncate(index.max(1));
                    }
                    _ => {
                        if resolved.len() > 1 {
                            resolved.push('/');
                        }
                        resolved.push_str(component);
                    }
                }
            }
            Ok(Rc::new(MemoryDirectory {
                fs: self.clone(),
                path: resolved,
            }) as Rc<dyn Directory>)
        })
    }
    fn stat<'a>(
        &'a self,
        path: &'a str,
        follow_symlinks: bool,
    ) -> LocalBoxFuture<'a, Result<FileMetadata, IoError>> {
        Box::pin(async move { MemoryFs::stat(self, path, follow_symlinks) })
    }
    fn mkdir<'a>(
        &'a self,
        path: &'a str,
        parents: bool,
    ) -> LocalBoxFuture<'a, Result<(), IoError>> {
        Box::pin(async move { MemoryFs::mkdir(self, path, parents) })
    }
    fn open<'a>(
        &'a self,
        path: &'a str,
        options: &'a OpenOptions,
    ) -> LocalBoxFuture<'a, Result<Endpoint, IoError>> {
        Box::pin(async move { MemoryFs::open(self, path, options) })
    }
}

fn memory_file_open(
    fs: Rc<RefCell<FsState>>,
    file: Rc<File>,
    options: &OpenOptions,
) -> Result<Endpoint, IoError> {
    if (!options.read && !options.write) || ((options.truncate || options.append) && !options.write)
    {
        return Err(IoError::BadDescriptor);
    }
    if options.truncate {
        let mut data = file.data.borrow_mut();
        fs.borrow_mut().used -= data.len();
        *data = Vec::new();
        file.modified();
    }
    Ok(Endpoint(Rc::new(Open::File(FileOpen {
        file,
        fs,
        offset: Cell::new(0),
        options: *options,
    }))))
}

/// Shell descriptor names refer to the shell's logical table, not WASI's private fds.
pub fn descriptor_number(path: &str) -> Option<u32> {
    match path {
        "/dev/stdin" => Some(0),
        "/dev/stdout" => Some(1),
        "/dev/stderr" => Some(2),
        _ => path
            .strip_prefix("/dev/fd/")
            .or_else(|| path.strip_prefix("/proc/self/fd/"))?
            .parse()
            .ok(),
    }
}

pub enum DescriptorOpen<'a> {
    /// Reopen through the production host, preserving inode policy and open state.
    RuntimePath(Cow<'a, str>),
    /// In-process streams and unexported buffers retain their existing semantics.
    Local(Endpoint),
}

impl DescriptorOpen<'_> {
    pub async fn open(
        self,
        fs: &dyn FileSystem,
        options: &OpenOptions,
    ) -> Result<Endpoint, IoError> {
        match self {
            Self::RuntimePath(path) => fs.open(&path, options).await,
            Self::Local(endpoint) => Ok(endpoint),
        }
    }
}

pub fn open_path<'a>(
    path: &'a str,
    fds: &FdTable,
    options: &OpenOptions,
) -> Result<DescriptorOpen<'a>, IoError> {
    let Some(logical) = descriptor_number(path) else {
        return Ok(DescriptorOpen::RuntimePath(Cow::Borrowed(path)));
    };
    reopen_descriptor(path, fds.get(logical).ok_or(IoError::NotFound)?, options)
}

fn reopen_descriptor(
    path: &str,
    endpoint: Endpoint,
    options: &OpenOptions,
) -> Result<DescriptorOpen<'static>, IoError> {
    if let Some(fd) = endpoint.runtime_fd() {
        let prefix = if path.starts_with("/proc/") {
            "/proc/self/fd"
        } else {
            "/dev/fd"
        };
        return Ok(DescriptorOpen::RuntimePath(Cow::Owned(format!(
            "{prefix}/{fd}"
        ))));
    }
    match endpoint.0.as_ref() {
        Open::File(file) => {
            memory_file_open(file.fs.clone(), file.file.clone(), options).map(DescriptorOpen::Local)
        }
        Open::Host(_) => Err(IoError::Unsupported),
        Open::PipeRead(_)
        | Open::PipeWrite(_)
        | Open::Capture(_)
        | Open::Null
        | Open::Bytes { .. } => Ok(DescriptorOpen::Local(endpoint)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::executor::Executor;
    use futures::{FutureExt, task::noop_waker};
    use std::{
        future::Future,
        task::{Context, Poll},
    };
    #[test]
    fn memory_descriptor_reopen_uses_same_inode_and_independent_description() {
        let fs = MemoryFs::new(32);
        fs.write_file("/f", b"abcd").unwrap();
        let source = fs.open("/f", &OpenOptions::default()).unwrap();
        let mut fds = FdTable::default();
        fds.insert(7, source.clone());
        let mut byte = [0];
        assert_eq!(source.read(&mut byte).now_or_never(), Some(Ok(1)));
        let reopened = open_path("/dev/fd/7", &fds, &OpenOptions::default())
            .unwrap()
            .open(&fs, &OpenOptions::default())
            .now_or_never()
            .unwrap()
            .unwrap();
        assert!(!source.same_open(&reopened));
        assert_eq!(reopened.read(&mut byte).now_or_never(), Some(Ok(1)));
        assert_eq!(&byte, b"a");
        fs.write_file("/f", b"wxyz").unwrap();
        assert_eq!(source.read(&mut byte).now_or_never(), Some(Ok(1)));
        assert_eq!(&byte, b"x");
        assert_eq!(reopened.read(&mut byte).now_or_never(), Some(Ok(1)));
        assert_eq!(&byte, b"x");
        let truncate = OpenOptions {
            read: false,
            write: true,
            truncate: true,
            ..OpenOptions::default()
        };
        let output = open_path("/dev/fd/7", &fds, &truncate)
            .unwrap()
            .open(&fs, &truncate)
            .now_or_never()
            .unwrap()
            .unwrap();
        assert_eq!(fs.used_bytes(), 0);
        assert_eq!(output.write(b"1234").now_or_never(), Some(Ok(4)));
        assert_eq!(source.read(&mut byte).now_or_never(), Some(Ok(1)));
        assert_eq!(&byte, b"3");
    }
    #[test]
    fn local_pipe_duplication_and_unexported_buffer_boundary_are_explicit() {
        let (reader, writer) = pipe();
        let mut fds = FdTable::default();
        fds.insert(7, reader.clone());
        let options = OpenOptions::default();
        let DescriptorOpen::Local(duplicate) = open_path("/dev/fd/7", &fds, &options).unwrap()
        else {
            panic!("native pipe stays local")
        };
        assert!(reader.same_open(&duplicate));
        assert_eq!(writer.write(b"ab").now_or_never(), Some(Ok(2)));
        let mut byte = [0];
        assert_eq!(duplicate.read(&mut byte).now_or_never(), Some(Ok(1)));
        assert_eq!(&byte, b"a");
        assert_eq!(reader.read(&mut byte).now_or_never(), Some(Ok(1)));
        assert_eq!(&byte, b"b");
        let buffer = Endpoint::bytes(b"ab".to_vec());
        fds.insert(7, buffer.clone());
        let DescriptorOpen::Local(retained) = open_path("/dev/fd/7", &fds, &options).unwrap()
        else {
            panic!("unexported buffers retain their old shared offset")
        };
        assert!(retained.same_open(&buffer));
    }
    #[test]
    fn filesystem_metadata_preserves_contents_identity_and_access_time() {
        let fs = MemoryFs::new(32);
        fs.write_file("/f", b"abc").unwrap();
        fs.write_file("/other", b"").unwrap();
        let before = fs.stat("/f", true).unwrap();
        assert_eq!(before.kind, FileKind::Regular);
        assert_eq!(before.size, 3);
        assert_eq!(before.mode.unwrap().bits, 0o666);
        assert_eq!(before.readable, Some(true));
        assert_eq!(before.writable, Some(true));
        assert_eq!(before.executable, Some(false));
        assert!(before.inode.is_some());
        assert!(before.device.is_some());
        assert_eq!(before, fs.stat("/f", false).unwrap());
        assert_ne!(before.inode, fs.stat("/other", true).unwrap().inode);
        assert_eq!(before.device, fs.stat("/other", true).unwrap().device);
        assert_ne!(
            before.device,
            MemoryFs::new(0).stat("/", true).unwrap().device
        );
        // Merely asking for metadata must not open/read the file, advance an
        // existing offset, or update the last-access timestamp.
        let file = fs.open("/f", &OpenOptions::default()).unwrap();
        assert_eq!(before, fs.stat("/f", true).unwrap());
        let mut byte = [0];
        assert_eq!(file.read(&mut byte).now_or_never(), Some(Ok(1)));
        assert_eq!(&byte, b"a");
        let read = fs.stat("/f", true).unwrap();
        assert!(read.accessed_ns >= before.accessed_ns);
        assert_eq!(read.modified_ns, before.modified_ns);
        fs.write_file("/f", b"longer").unwrap();
        let updated = fs.stat("/f", true).unwrap();
        assert_eq!(updated.inode, before.inode);
        assert_eq!(updated.size, 6);
        assert!(updated.modified_ns >= before.modified_ns);
        fs.open(
            "/f",
            &OpenOptions {
                write: true,
                truncate: true,
                ..OpenOptions::default()
            },
        )
        .unwrap();
        let truncated = fs.stat("/f", true).unwrap();
        assert_eq!(truncated.inode, before.inode);
        assert_eq!(truncated.size, 0);
        assert_eq!(fs.used_bytes(), 0);
    }
    #[test]
    fn filesystem_metadata_resolves_real_directories_and_dot_components() {
        let fs = MemoryFs::new(8);
        fs.mkdir("/a/b", true).unwrap();
        fs.write_file("/a/f", b"x").unwrap();
        let directory = fs.stat("/a/", true).unwrap();
        assert_eq!(directory.kind, FileKind::Directory);
        assert_eq!(directory.executable, Some(true));
        assert_eq!(directory, fs.stat("/a/b/..", false).unwrap());
        assert_eq!(fs.stat("/a/f", true), fs.stat("//a/./b/../f", true));
        assert_eq!(fs.stat("/", true), fs.stat("/../../", true));
        assert_eq!(fs.stat("/a/f/", true), Err(IoError::NotDirectory));
        assert_eq!(fs.stat("/a/f/..", true), Err(IoError::NotDirectory));
        assert_eq!(fs.stat("/a/f/.", true), Err(IoError::NotDirectory));
        assert_eq!(fs.stat("/missing/../a/f", true), Err(IoError::NotFound));
        assert_eq!(fs.stat("/missing", true), Err(IoError::NotFound));
        assert_eq!(fs.stat("a", true), Err(IoError::InvalidPath));
        assert_eq!(fs.stat("/bad\0name", true), Err(IoError::InvalidPath));
        assert_eq!(
            fs.stat(&format!("/{}", "x".repeat(MAX_PATH_BYTES)), true),
            Err(IoError::InvalidPath)
        );
    }
    #[test]
    fn filesystem_metadata_updates_directory_time_only_for_new_children() {
        let fs = MemoryFs::new(8);
        fs.mkdir("/dir", false).unwrap();
        let reset_time = || {
            fs.0.borrow_mut()
                .directories
                .get_mut("/dir")
                .unwrap()
                .modified_ns = Some(1);
        };
        reset_time();
        fs.write_file("/dir/file", b"x").unwrap();
        assert!(fs.stat("/dir", true).unwrap().modified_ns > Some(1));
        reset_time();
        fs.write_file("/dir/file", b"xx").unwrap();
        assert_eq!(fs.stat("/dir", true).unwrap().modified_ns, Some(1));
        fs.mkdir("/dir/child", false).unwrap();
        assert!(fs.stat("/dir", true).unwrap().modified_ns > Some(1));
        reset_time();
        fs.open(
            "/dir/created",
            &OpenOptions {
                write: true,
                create: true,
                ..OpenOptions::default()
            },
        )
        .unwrap();
        assert!(fs.stat("/dir", true).unwrap().modified_ns > Some(1));
    }
    #[test]
    fn filesystem_metadata_tracks_reads_and_descriptor_writes() {
        let fs = MemoryFs::new(16);
        fs.write_file("/f", b"x").unwrap();
        let file = fs.0.borrow().files["/f"].clone();
        let mut metadata = file.metadata.get();
        metadata.accessed_ns = Some(1);
        metadata.modified_ns = Some(1);
        file.metadata.set(metadata);
        assert_eq!(fs.stat("/f", true).unwrap().accessed_ns, Some(1));
        assert_eq!(fs.read_file("/f").unwrap(), b"x");
        assert!(fs.stat("/f", true).unwrap().accessed_ns > Some(1));
        let output = fs
            .open(
                "/f",
                &OpenOptions {
                    write: true,
                    append: true,
                    ..OpenOptions::default()
                },
            )
            .unwrap();
        assert_eq!(output.write(b"yz").now_or_never(), Some(Ok(2)));
        let after = fs.stat("/f", true).unwrap();
        assert_eq!(after.size, 3);
        assert!(after.modified_ns > Some(1));
    }
    #[test]
    fn exact_capacity_partial_io_and_last_close() {
        let (read, write) = pipe();
        let duplicate = write.clone();
        assert_eq!(
            write.write(&vec![7; PIPE_CAPACITY + 9]).now_or_never(),
            Some(Ok(PIPE_CAPACITY))
        );
        assert!(write.write(&[1]).now_or_never().is_none());
        let mut buf = [0; 3];
        assert_eq!(read.read(&mut buf).now_or_never(), Some(Ok(3)));
        assert_eq!(buf, [7; 3]);
        assert_eq!(
            write.write(&vec![1; PIPE_BUF + 1]).now_or_never(),
            Some(Ok(3))
        );
        drop(write);
        let mut all = vec![0; PIPE_CAPACITY];
        assert_eq!(read.read(&mut all).now_or_never(), Some(Ok(PIPE_CAPACITY)));
        assert!(read.read(&mut buf).now_or_never().is_none());
        drop(duplicate);
        assert_eq!(read.read(&mut buf).now_or_never(), Some(Ok(0)));
    }
    #[test]
    fn competing_small_pipe_writes_are_atomic_under_capacity_pressure() {
        let (read, write) = pipe();
        let prefix_len = PIPE_CAPACITY - (PIPE_BUF - 1);
        let prefix = vec![b'P'; prefix_len];
        assert_eq!(write.write(&prefix).now_or_never(), Some(Ok(prefix_len)));

        let first = vec![b'A'; PIPE_BUF];
        let second = vec![b'B'; PIPE_BUF];
        let executor = Executor::new();
        let first_writer = {
            let write = write.clone();
            let record = first.clone();
            executor.spawn(async move { write.write_all(&record, &Cancel::new()).await })
        };
        let second_writer = {
            let write = write.clone();
            let record = second.clone();
            executor.spawn(async move { write.write_all(&record, &Cancel::new()).await })
        };

        // Establish pressure before making room. The old implementation lets
        // the first writer consume the final PIPE_BUF - 1 bytes here, queuing
        // a split record before the reader can make progress.
        executor.drive(8);
        assert!(!first_writer.is_finished());
        assert!(!second_writer.is_finished());

        let mut observed_prefix = vec![0; prefix_len];
        assert_eq!(
            read.read(&mut observed_prefix).now_or_never(),
            Some(Ok(prefix_len))
        );
        assert_eq!(observed_prefix, prefix);

        let mut tail = Vec::with_capacity(PIPE_BUF * 2);
        for _ in 0..16 {
            executor.drive(32);
            let buffered = match read.0.as_ref() {
                Open::PipeRead(pipe) => pipe.state.borrow().bytes.len(),
                _ => unreachable!(),
            };
            if buffered != 0 {
                let mut chunk = vec![0; PIPE_CAPACITY];
                let count = read.read(&mut chunk).now_or_never().unwrap().unwrap();
                tail.extend_from_slice(&chunk[..count]);
            }
            if first_writer.is_finished() && second_writer.is_finished() && buffered == 0 {
                break;
            }
        }

        assert_eq!(first_writer.now_or_never(), Some(Ok(())));
        assert_eq!(second_writer.now_or_never(), Some(Ok(())));
        let mut first_order = first.clone();
        first_order.extend_from_slice(&second);
        let mut second_order = second;
        second_order.extend_from_slice(&first);
        assert!(tail == first_order || tail == second_order);
    }

    #[test]
    fn blocked_small_pipe_writes_remove_only_their_own_cancelled_or_dropped_waiter() {
        for cancelled in [false, true] {
            let (read, write) = pipe();
            let prefix = vec![b'P'; PIPE_CAPACITY - 1];
            assert_eq!(write.write(&prefix).now_or_never(), Some(Ok(prefix.len())));
            let Open::PipeRead(pipe) = read.0.as_ref() else {
                unreachable!()
            };
            let cancel = Cancel::new();
            let record = [b'A'; PIPE_BUF];
            let mut abandoned = Box::pin(write.write_cancelled(&record, &cancel));
            let peer = write.clone();
            let mut pending = Box::pin(peer.write(b"BC"));
            let waker = noop_waker();
            let mut context = Context::from_waker(&waker);
            for _ in 0..100 {
                assert!(abandoned.as_mut().poll(&mut context).is_pending());
                assert!(pending.as_mut().poll(&mut context).is_pending());
                assert_eq!(pipe.writable.waiter_count(), 2);
                assert_eq!(pipe.state.borrow().bytes.len(), prefix.len());
            }
            if cancelled {
                cancel.cancel();
                assert_eq!(
                    abandoned.as_mut().poll(&mut context),
                    Poll::Ready(Err(IoError::Cancelled))
                );
            }
            drop(abandoned);
            assert_eq!(pipe.writable.waiter_count(), 1);

            let mut output = vec![0; PIPE_CAPACITY];
            assert_eq!(
                read.read(&mut output).now_or_never(),
                Some(Ok(prefix.len()))
            );
            assert_eq!(&output[..prefix.len()], prefix);
            assert_eq!(pending.as_mut().poll(&mut context), Poll::Ready(Ok(2)));
            drop(pending);
            assert_eq!(pipe.writable.waiter_count(), 0);
            assert_eq!(read.read(&mut output).now_or_never(), Some(Ok(2)));
            assert_eq!(&output[..2], b"BC");
        }
    }

    #[test]
    fn blocked_small_pipe_write_reports_last_reader_close() {
        let (read, write) = pipe();
        let duplicate = read.clone();
        assert_eq!(
            write.write(&vec![0; PIPE_CAPACITY - 1]).now_or_never(),
            Some(Ok(PIPE_CAPACITY - 1))
        );
        let executor = Executor::new();
        let writer = executor.spawn(async move { write.write(b"AB").await });
        executor.drive(8);
        assert!(!writer.is_finished());
        drop(read);
        executor.drive(8);
        assert!(!writer.is_finished());
        drop(duplicate);
        executor.drive(8);
        assert_eq!(writer.now_or_never(), Some(Err(IoError::BrokenPipe)));
    }

    #[test]
    fn empty_io_and_epipe_last_reader() {
        let (read, write) = pipe();
        let dup = read.clone();
        drop(read);
        assert_eq!(write.write(b"x").now_or_never(), Some(Ok(1)));
        drop(dup);
        assert_eq!(write.write(b"").now_or_never(), Some(Ok(0)));
        assert_eq!(
            write.write(b"x").now_or_never(),
            Some(Err(IoError::BrokenPipe))
        );
    }
    #[test]
    fn cancelled_io_removes_all_waiters_and_wakes_peers() {
        let (read, write) = pipe();
        let cancel = Cancel::new();
        let mut output = [0; 1];
        let mut operation = Box::pin(read.read_cancelled(&mut output, &cancel));
        let waker = noop_waker();
        let mut cx = Context::from_waker(&waker);
        for _ in 0..100 {
            assert!(operation.as_mut().poll(&mut cx).is_pending());
        }
        let Open::PipeRead(state) = read.0.as_ref() else {
            unreachable!()
        };
        assert_eq!(state.readable.waiter_count(), 1);
        cancel.cancel();
        assert_eq!(
            operation.as_mut().poll(&mut cx),
            Poll::Ready(Err(IoError::Cancelled))
        );
        drop(operation);
        assert_eq!(state.readable.waiter_count(), 0);
        assert_eq!(
            write.write(&vec![0; PIPE_CAPACITY]).now_or_never(),
            Some(Ok(PIPE_CAPACITY))
        );
        let cancel = Cancel::new();
        let mut operation = Box::pin(write.write_cancelled(b"x", &cancel));
        assert!(operation.as_mut().poll(&mut cx).is_pending());
        assert_eq!(state.writable.waiter_count(), 1);
        drop(operation);
        assert_eq!(state.writable.waiter_count(), 0);
        let ex = Executor::new();
        let writer = ex.spawn(async move { write.write(b"x").await });
        ex.drive(10);
        assert!(!writer.is_finished());
        drop(read);
        ex.drive(10);
        assert_eq!(writer.now_or_never(), Some(Err(IoError::BrokenPipe)));
    }
    #[test]
    fn capture_limit_and_file_open_description_offsets() {
        let (sink, capture) = capture(3);
        assert_eq!(sink.write(b"abc").now_or_never(), Some(Ok(3)));
        assert_eq!(
            sink.write(b"d").now_or_never(),
            Some(Err(IoError::LimitExceeded))
        );
        assert_eq!(capture.bytes(), b"abc");
        let fs = MemoryFs::new(6);
        fs.write_file("/f", b"abcdef").unwrap();
        let file = fs.open("/f", &OpenOptions::default()).unwrap();
        let duplicate = file.clone();
        let other = fs.open("/f", &OpenOptions::default()).unwrap();
        let mut a = [0; 2];
        let mut b = [0; 2];
        let mut c = [0; 2];
        assert_eq!(file.read(&mut a).now_or_never(), Some(Ok(2)));
        assert_eq!(duplicate.read(&mut b).now_or_never(), Some(Ok(2)));
        assert_eq!(other.read(&mut c).now_or_never(), Some(Ok(2)));
        assert_eq!((a, b, c), (*b"ab", *b"cd", *b"ab"));
        assert_eq!(fs.write_file("/g", b"x"), Err(IoError::LimitExceeded));
        let truncate = OpenOptions {
            write: true,
            truncate: true,
            ..OpenOptions::default()
        };
        fs.open("/f", &truncate).unwrap();
        assert_eq!(fs.used_bytes(), 0);
        fs.write_file("/g", b"123456").unwrap();
        assert_eq!(fs.used_bytes(), 6);
    }
    #[test]
    fn runtime_endpoint_is_cancellable_and_closes_on_last_reference() {
        struct RuntimeRead {
            endpoint: Endpoint,
            closed: Rc<Cell<bool>>,
        }
        impl HostEndpoint for RuntimeRead {
            fn read<'a>(
                &'a self,
                output: &'a mut [u8],
            ) -> LocalBoxFuture<'a, Result<usize, IoError>> {
                Box::pin(self.endpoint.read(output))
            }
            fn write<'a>(&'a self, _: &'a [u8]) -> LocalBoxFuture<'a, Result<usize, IoError>> {
                Box::pin(async { Ok(0) })
            }
        }
        impl Drop for RuntimeRead {
            fn drop(&mut self) {
                self.closed.set(true);
            }
        }
        let (read, write) = pipe();
        let closed = Rc::new(Cell::new(false));
        let endpoint = Endpoint::host(Rc::new(RuntimeRead {
            endpoint: read,
            closed: closed.clone(),
        }));
        let duplicate = endpoint.clone();
        let cancel = Cancel::new();
        let mut output = [0; 1];
        let mut operation = Box::pin(endpoint.read_cancelled(&mut output, &cancel));
        let waker = noop_waker();
        let mut cx = Context::from_waker(&waker);
        assert!(operation.as_mut().poll(&mut cx).is_pending());
        cancel.cancel();
        assert_eq!(
            operation.as_mut().poll(&mut cx),
            Poll::Ready(Err(IoError::Cancelled))
        );
        drop(operation);
        assert_eq!(endpoint.read(&mut []).now_or_never(), Some(Ok(0)));
        assert_eq!(endpoint.write(b"").now_or_never(), Some(Ok(0)));
        assert_eq!(
            endpoint.write_all(b"x", &Cancel::new()).now_or_never(),
            Some(Err(IoError::WriteZero))
        );
        drop(endpoint);
        assert!(!closed.get());
        drop(duplicate);
        assert!(closed.get());
        assert_eq!(
            write.write(b"x").now_or_never(),
            Some(Err(IoError::BrokenPipe))
        );
    }
    #[test]
    fn file_append_truncation_and_allocation_bounds() {
        let fs = MemoryFs::new(8);
        fs.write_file("/f", b"abcd").unwrap();
        let original = fs
            .open(
                "/f",
                &OpenOptions {
                    write: true,
                    ..OpenOptions::default()
                },
            )
            .unwrap();
        let mut bytes = [0; 4];
        assert_eq!(original.read(&mut bytes).now_or_never(), Some(Ok(4)));
        let append = fs
            .open(
                "/f",
                &OpenOptions {
                    write: true,
                    append: true,
                    ..OpenOptions::default()
                },
            )
            .unwrap();
        assert_eq!(append.write(b"ef").now_or_never(), Some(Ok(2)));
        fs.open(
            "/f",
            &OpenOptions {
                write: true,
                truncate: true,
                ..OpenOptions::default()
            },
        )
        .unwrap();
        assert_eq!(original.read(&mut bytes).now_or_never(), Some(Ok(0))); // EOF must not move offset backwards
        assert_eq!(original.write(b"z").now_or_never(), Some(Ok(1)));
        assert_eq!(fs.read_file("/f").unwrap(), b"\0\0\0\0z");
        assert_eq!(append.write(b"xy").now_or_never(), Some(Ok(2)));
        assert_eq!(fs.read_file("/f").unwrap(), b"\0\0\0\0zxy");
        assert_eq!(
            append.write(b"too much").now_or_never(),
            Some(Err(IoError::LimitExceeded))
        );
        assert_eq!(fs.used_bytes(), 7);
        assert_eq!(
            fs.write_file(&"x".repeat(MAX_PATH_BYTES + 1), b""),
            Err(IoError::InvalidPath)
        );
        for index in 1..MAX_MEMORY_FILES {
            fs.write_file(&format!("/{index}"), b"").unwrap();
        }
        assert_eq!(fs.write_file("/overflow", b""), Err(IoError::LimitExceeded));
    }
    #[test]
    fn arbitrary_fds_share_open_endpoints() {
        let (read, write) = pipe();
        let mut fds = FdTable::default();
        fds.insert(99, write);
        let mut child = fds.clone();
        drop(fds);
        let inherited = child.remove(99).unwrap();
        assert_eq!(inherited.write(b"bytes").now_or_never(), Some(Ok(5)));
        drop(inherited);
        let mut bytes = [0; 6];
        assert_eq!(read.read(&mut bytes).now_or_never(), Some(Ok(5)));
        assert_eq!(&bytes[..5], b"bytes");
        assert_eq!(read.read(&mut bytes).now_or_never(), Some(Ok(0)));
    }
}
