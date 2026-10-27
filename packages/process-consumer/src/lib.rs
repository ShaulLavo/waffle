//! Process execution for WASI utilities on the caller's existing Waffle runtime.
//! Native builds expose only request codecs and status types, never host execution.
//!
//! Ordinary source imports are admitted by Waffle. Blocking collection uses its
//! signal-preserving physical-retirement wait; the host owns fatal-caller cleanup.
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::io::{self, Write};

#[cfg(all(target_arch = "wasm32", target_os = "wasi"))]
mod wasi;
#[cfg(all(target_arch = "wasm32", target_os = "wasi"))]
pub use wasi::{
    Child, inherited_shell_descriptors, inherited_stdio, resolve_executable, run, spawn,
};

/// Maximum encoded spawn JSON. Requests above this bound fail before spawning.
pub const MAX_REQUEST_BYTES: usize = 1024 * 1024;

/// Borrow a parent descriptor at its existing number or remap it in the child.
/// Spawn retains its own binding; this crate never closes the parent's descriptor.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct DescriptorBinding {
    pub child: u32,
    pub parent: u32,
}
impl DescriptorBinding {
    pub const fn inherit(fd: u32) -> Self {
        Self {
            child: fd,
            parent: fd,
        }
    }
}

/// Exact launch data. There is no implicit argv0, environment merge or fd inheritance.
/// `executable` is a path, not a shell expression. Use `resolve_executable` for PATH.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    pub executable: String,
    pub argv: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: String,
    pub fds: Vec<DescriptorBinding>,
}

#[derive(Serialize)]
struct WireRequest<'a> {
    executable: &'a str,
    argv: &'a [String],
    env: &'a BTreeMap<String, String>,
    cwd: &'a str,
    job: i32,
    #[serde(rename = "jobLifetime")]
    job_lifetime: &'static str,
    fds: &'a [DescriptorBinding],
}

impl Request {
    /// Encode P's JSON contract, with a new foreground job owned by this caller.
    pub fn encode(&self) -> Result<Vec<u8>, Error> {
        validate_request(self)?;
        let wire = WireRequest {
            executable: &self.executable,
            argv: &self.argv,
            env: &self.env,
            cwd: &self.cwd,
            job: 0,
            job_lifetime: "caller-fatal",
            fds: &self.fds,
        };
        let mut output = BoundedJson(Vec::new());
        serde_json::to_writer(&mut output, &wire).map_err(|error| match error.io_error_kind() {
            Some(io::ErrorKind::OutOfMemory) => Error::Host {
                operation: "encode",
                errno: 48,
            },
            _ => Error::RequestTooLarge,
        })?;
        Ok(output.0)
    }
}

struct BoundedJson(Vec<u8>);
impl Write for BoundedJson {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > MAX_REQUEST_BYTES.saturating_sub(self.0.len()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "spawn JSON too large",
            ));
        }
        self.0
            .try_reserve(bytes.len())
            .map_err(|error| io::Error::new(io::ErrorKind::OutOfMemory, error))?;
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn validate_request(request: &Request) -> Result<(), Error> {
    validate_path(&request.executable, false)?;
    validate_path(&request.cwd, true)?;
    for argument in &request.argv {
        if argument.contains('\0') {
            return Err(Error::InvalidInput("NUL in argv"));
        }
    }
    for (key, value) in &request.env {
        if key.contains(['=', '\0']) || value.contains('\0') {
            return Err(Error::InvalidInput("invalid environment entry"));
        }
    }
    let mut targets = BTreeSet::new();
    for binding in &request.fds {
        validate_binding(*binding, &mut targets)?;
    }
    Ok(())
}

fn validate_binding(binding: DescriptorBinding, targets: &mut BTreeSet<u32>) -> Result<(), Error> {
    // P's DescriptorTable reserves the signed i32 return range for descriptor IDs.
    if binding.child > 0x7fff_ffff || binding.parent > 0x7fff_ffff {
        return Err(Error::InvalidInput("descriptor outside P's range"));
    }
    if !targets.insert(binding.child) {
        return Err(Error::InvalidInput("duplicate child descriptor"));
    }
    Ok(())
}

pub(crate) fn validate_path(path: &str, absolute: bool) -> Result<(), Error> {
    if path.is_empty() || path.contains('\0') || (absolute && !path.starts_with('/')) {
        return Err(Error::InvalidInput(
            "expected a nonempty path and absolute cwd without NUL",
        ));
    }
    if path.len() > MAX_REQUEST_BYTES {
        return Err(Error::RequestTooLarge);
    }
    Ok(())
}

/// Waffle's typed outcome. A real exit 126/127 remains distinct from startup failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Exited(i32),
    Signaled(u8),
    StartFailed(u16),
}
impl Outcome {
    /// Decode exactly eight little-endian bytes, without Rust layout assumptions.
    pub fn decode(bytes: [u8; 8]) -> Result<Self, Error> {
        let kind = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        let value = i32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
        match kind {
            0 => Ok(Self::Exited(value)),
            1 if (1..=64).contains(&value) && value != 32 && value != 33 => Ok(Self::Signaled(
                u8::try_from(value).map_err(|_| Error::InvalidRecord)?,
            )),
            2 if matches!(value, 44 | 2 | 54 | 45 | 48 | 6 | 29) => Ok(Self::StartFailed(
                u16::try_from(value).map_err(|_| Error::InvalidRecord)?,
            )),
            _ => Err(Error::InvalidRecord),
        }
    }
    pub fn shell_status(self) -> i32 {
        match self {
            Self::Exited(code) => code,
            Self::Signaled(signal) => 128 + i32::from(signal),
            Self::StartFailed(44) => 127,
            Self::StartFailed(_) => 126,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    InvalidInput(&'static str),
    RequestTooLarge,
    InvalidRecord,
    Host {
        operation: &'static str,
        errno: i32,
    },
    /// A handled signal canceled the child job. Teardown finished before this error.
    Interrupted(u8),
}
impl fmt::Display for Error {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidInput(reason) => write!(output, "invalid process request: {reason}"),
            Self::RequestTooLarge => {
                write!(output, "process request exceeds {MAX_REQUEST_BYTES} bytes")
            }
            Self::InvalidRecord => write!(output, "invalid runtime_proc result"),
            Self::Host { operation, errno } => {
                write!(output, "runtime_proc.{operation}: WASI errno {errno}")
            }
            Self::Interrupted(signal) => {
                write!(output, "process execution canceled by signal {signal}")
            }
        }
    }
}
impl std::error::Error for Error {}

/// Convert the negative errno convention without overflowing on malformed i32::MIN.
pub fn decode_host_result(operation: &'static str, value: i32) -> Result<u32, Error> {
    if value >= 0 {
        return u32::try_from(value).map_err(|_| Error::InvalidRecord);
    }
    let errno = value.checked_neg().ok_or(Error::InvalidRecord)?;
    Err(Error::Host { operation, errno })
}
