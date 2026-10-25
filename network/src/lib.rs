//! TCP state shared by the standalone WebAssembly module and native host tests.
//! Bun-specific handles, JSON and error messages do not belong here.
use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};

pub mod abi;
#[cfg(target_arch = "wasm32")]
mod module;
#[cfg(not(target_arch = "wasm32"))]
pub mod native;
mod queue;
pub mod virtual_net;

/// Opaque transport resource, distinct from a guest's handle table.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SocketId(pub u32);

/// Immediate, nonblocking OS operations. An in-progress dial returns WouldBlock.
pub trait SocketHost {
    fn open(&mut self, ipv6: bool) -> io::Result<u32>;
    fn dual_stack(&mut self, socket: u32) -> io::Result<()>;
    fn bind(&mut self, socket: u32, address: SocketAddr) -> io::Result<()>;
    fn listen(&mut self, socket: u32) -> io::Result<()>;
    fn connect(&mut self, socket: u32, address: SocketAddr) -> io::Result<()>;
    fn connected(&mut self, socket: u32) -> io::Result<()>;
    fn accept(&mut self, socket: u32) -> io::Result<u32>;
    fn read(&mut self, socket: u32, bytes: &mut [u8]) -> io::Result<usize>;
    fn write(&mut self, socket: u32, bytes: &[u8]) -> io::Result<usize>;
    fn shutdown(&mut self, socket: u32) -> io::Result<()>;
    fn local_addr(&mut self, socket: u32) -> io::Result<SocketAddr>;
    fn peer_addr(&mut self, socket: u32) -> io::Result<SocketAddr>;
    fn close(&mut self, socket: u32);
}

enum State {
    Listener,
    Stream(Stream),
}
enum Phase {
    Connecting,
    Open,
    Failed(io::ErrorKind),
}
struct Stream {
    phase: Phase,
    received: queue::ByteQueue,
    outgoing: queue::ByteQueue,
    eof: bool,
    shutdown: bool,
    shutdown_sent: bool,
}
impl Stream {
    fn new(connecting: bool) -> Self {
        Self {
            phase: if connecting {
                Phase::Connecting
            } else {
                Phase::Open
            },
            received: Default::default(),
            outgoing: Default::default(),
            eof: false,
            shutdown: false,
            shutdown_sent: false,
        }
    }
    fn connected(&mut self, host: &mut impl SocketHost, id: u32) -> io::Result<()> {
        match self.phase {
            Phase::Open => return Ok(()),
            Phase::Failed(kind) => return Err(kind.into()),
            Phase::Connecting => {}
        }
        match host.connected(id) {
            Ok(()) => {
                self.phase = Phase::Open;
                Ok(())
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => Err(error),
            Err(error) => {
                self.phase = Phase::Failed(error.kind());
                Err(error)
            }
        }
    }
    fn interests(&self) -> u32 {
        match self.phase {
            Phase::Connecting => 2,
            Phase::Failed(_) => 4,
            Phase::Open => {
                u32::from(!self.eof && self.received.len() < virtual_net::LIMIT)
                    | (u32::from(!self.outgoing.is_empty()) << 1)
            }
        }
    }
    fn progress(&mut self, host: &mut impl SocketHost, id: u32) -> io::Result<()> {
        self.connected(host, id)?;
        self.flush(host, id)?;
        if self.shutdown && self.outgoing.is_empty() && !self.shutdown_sent {
            host.shutdown(id)?;
            self.shutdown_sent = true;
        }
        if self.eof || self.received.len() == virtual_net::LIMIT {
            return Ok(());
        }
        let mut bytes = [0; abi::BUFFER_SIZE];
        let length = bytes.len().min(virtual_net::LIMIT - self.received.len());
        match host.read(id, &mut bytes[..length]) {
            Ok(0) => self.eof = true,
            Ok(count) => self.received.push(&bytes[..count]),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
            Err(error) => {
                self.phase = Phase::Failed(error.kind());
                return Err(error);
            }
        }
        Ok(())
    }
    fn flush(&mut self, host: &mut impl SocketHost, id: u32) -> io::Result<()> {
        if self.outgoing.is_empty() {
            return Ok(());
        }
        match host.write(id, self.outgoing.front()) {
            Ok(0) => Err(io::ErrorKind::WriteZero.into()),
            Ok(count) => {
                self.outgoing.consume(count);
                Ok(())
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(()),
            Err(error) => {
                self.phase = Phase::Failed(error.kind());
                Err(error)
            }
        }
    }
}

/// One explicitly owned instance. Dropping it closes every remaining OS resource.
pub struct Tcp<H: SocketHost> {
    host: H,
    sockets: BTreeMap<u32, State>,
    issued: BTreeSet<u32>,
}

impl<H: SocketHost> Tcp<H> {
    pub fn new(host: H) -> Self {
        Self {
            host,
            sockets: BTreeMap::new(),
            issued: BTreeSet::new(),
        }
    }

    /// Prefer IPv6-any with IPV6_V6ONLY disabled, then try IPv4-any.
    pub fn listen_default(&mut self, port: u16) -> io::Result<SocketId> {
        self.listen(SocketAddr::new(Ipv6Addr::UNSPECIFIED.into(), port))
    }

    pub fn listen(&mut self, address: SocketAddr) -> io::Result<SocketId> {
        let dual = address.ip() == Ipv6Addr::UNSPECIFIED;
        match self.bind_listener(address, dual) {
            Ok(socket) => Ok(socket),
            Err(error)
                if dual
                    && matches!(
                        error.kind(),
                        io::ErrorKind::Unsupported | io::ErrorKind::AddrNotAvailable
                    ) =>
            {
                self.bind_listener(
                    SocketAddr::new(Ipv4Addr::UNSPECIFIED.into(), address.port()),
                    false,
                )
            }
            Err(error) => Err(error),
        }
    }

    fn bind_listener(&mut self, address: SocketAddr, dual: bool) -> io::Result<SocketId> {
        let socket = self.host.open(address.is_ipv6())?;
        self.claim(socket)?;
        let bound = self.configure_listener(socket, address, dual);
        if let Err(error) = bound {
            self.host.close(socket);
            return Err(error);
        }
        self.sockets.insert(socket, State::Listener);
        Ok(SocketId(socket))
    }

    fn configure_listener(
        &mut self,
        socket: u32,
        address: SocketAddr,
        dual: bool,
    ) -> io::Result<()> {
        if dual {
            self.host.dual_stack(socket)?;
        }
        self.host.bind(socket, address)?;
        self.host.listen(socket)
    }

    pub fn connect(&mut self, address: SocketAddr) -> io::Result<SocketId> {
        let socket = self.host.open(address.is_ipv6())?;
        self.claim(socket)?;
        let connecting = match self.host.connect(socket, address) {
            Ok(()) => false,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => true,
            Err(error) => {
                self.host.close(socket);
                return Err(error);
            }
        };
        self.sockets
            .insert(socket, State::Stream(Stream::new(connecting)));
        Ok(SocketId(socket))
    }

    pub fn accept(&mut self, listener: SocketId) -> io::Result<SocketId> {
        if !matches!(self.sockets.get(&listener.0), Some(State::Listener)) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let socket = self.host.accept(listener.0)?;
        self.claim(socket)?;
        self.sockets
            .insert(socket, State::Stream(Stream::new(false)));
        Ok(SocketId(socket))
    }

    fn claim(&mut self, socket: u32) -> io::Result<()> {
        if socket > 0 && socket <= i32::MAX as u32 && self.issued.insert(socket) {
            return Ok(());
        }
        // A duplicate live token refers to the existing resource, not a new one to close.
        if !self.sockets.contains_key(&socket) {
            self.host.close(socket);
        }
        Err(io::ErrorKind::InvalidInput.into())
    }

    /// Close resources without permitting delayed readiness to alias a reused host token.
    pub fn dispose(&mut self) {
        for socket in std::mem::take(&mut self.sockets).keys() {
            self.host.close(*socket);
        }
    }

    fn stream(&mut self, socket: SocketId) -> io::Result<&mut Stream> {
        let Some(State::Stream(stream)) = self.sockets.get_mut(&socket.0) else {
            return Err(io::ErrorKind::InvalidInput.into());
        };
        stream.connected(&mut self.host, socket.0)?;
        Ok(stream)
    }

    /// OS readiness needed for progress. Terminal state (4) needs no OS wait.
    pub fn interests(&self, socket: SocketId) -> io::Result<u32> {
        match self.sockets.get(&socket.0) {
            Some(State::Listener) => Ok(1),
            Some(State::Stream(stream)) => Ok(stream.interests()),
            None => Err(io::ErrorKind::InvalidInput.into()),
        }
    }

    /// Drive one bounded turn after host readiness. No sleeping, threads or retained pointers.
    pub fn poll(&mut self, socket: SocketId) -> io::Result<()> {
        let Some(State::Stream(stream)) = self.sockets.get_mut(&socket.0) else {
            return Err(io::ErrorKind::InvalidInput.into());
        };
        stream.progress(&mut self.host, socket.0)
    }
    pub fn read(&mut self, socket: SocketId, bytes: &mut [u8]) -> io::Result<usize> {
        let progress = self.poll(socket);
        let Some(State::Stream(stream)) = self.sockets.get_mut(&socket.0) else {
            return Err(io::ErrorKind::InvalidInput.into());
        };
        if !stream.received.is_empty() {
            return Ok(stream.received.take(bytes));
        }
        progress?;
        if stream.eof || bytes.is_empty() {
            return Ok(0);
        }
        Err(io::ErrorKind::WouldBlock.into())
    }
    pub fn write(&mut self, socket: SocketId, bytes: &[u8]) -> io::Result<usize> {
        self.poll(socket)?;
        let stream = self.stream(socket)?;
        if stream.shutdown {
            return Err(io::ErrorKind::BrokenPipe.into());
        }
        let room = virtual_net::LIMIT.saturating_sub(stream.outgoing.len());
        if room == 0 && !bytes.is_empty() {
            return Err(io::ErrorKind::WouldBlock.into());
        }
        let count = bytes.len().min(room.max(abi::BUFFER_SIZE));
        stream.outgoing.push(&bytes[..count]);
        // Admission succeeded. A subsequent transport failure remains sticky for the next call.
        let _ = self.poll(socket);
        Ok(count)
    }
    pub fn shutdown(&mut self, socket: SocketId) -> io::Result<()> {
        self.stream(socket)?.shutdown = true;
        self.poll(socket)
    }

    pub fn local_addr(&mut self, socket: SocketId) -> io::Result<SocketAddr> {
        self.require(socket)?;
        self.host.local_addr(socket.0)
    }

    pub fn peer_addr(&mut self, socket: SocketId) -> io::Result<SocketAddr> {
        self.stream(socket)?;
        self.host.peer_addr(socket.0)
    }

    fn require(&self, socket: SocketId) -> io::Result<()> {
        if self.sockets.contains_key(&socket.0) {
            return Ok(());
        }
        Err(io::ErrorKind::InvalidInput.into())
    }

    pub fn close(&mut self, socket: SocketId) -> io::Result<()> {
        self.sockets
            .remove(&socket.0)
            .ok_or(io::ErrorKind::InvalidInput)?;
        self.host.close(socket.0);
        Ok(())
    }
}

impl<H: SocketHost> Drop for Tcp<H> {
    fn drop(&mut self) {
        self.dispose();
    }
}
