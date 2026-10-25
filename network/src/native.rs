//! Reference OS binding. This file is never compiled into the WebAssembly leaf.
use crate::SocketHost;
use socket2::{Domain, Protocol, Socket, Type};
use std::collections::BTreeMap;
use std::io::{self, Read, Write};
use std::net::{Shutdown, SocketAddr};

#[derive(Default)]
pub struct NativeHost {
    sockets: BTreeMap<u32, Socket>,
    next: u32,
}

impl NativeHost {
    fn insert(&mut self, socket: Socket) -> io::Result<u32> {
        let id = self
            .next
            .checked_add(1)
            .filter(|id| *id <= i32::MAX as u32)
            .ok_or(io::ErrorKind::OutOfMemory)?;
        self.next = id;
        socket.set_nonblocking(true)?;
        self.sockets.insert(id, socket);
        Ok(id)
    }

    fn socket(&self, id: u32) -> io::Result<&Socket> {
        self.sockets
            .get(&id)
            .ok_or_else(|| io::ErrorKind::InvalidInput.into())
    }
}

impl SocketHost for NativeHost {
    fn open(&mut self, ipv6: bool) -> io::Result<u32> {
        self.insert(
            Socket::new(
                if ipv6 { Domain::IPV6 } else { Domain::IPV4 },
                Type::STREAM,
                Some(Protocol::TCP),
            )
            .map_err(socket_error)?,
        )
    }
    fn dual_stack(&mut self, socket: u32) -> io::Result<()> {
        self.socket(socket)?.set_only_v6(false)
    }
    fn bind(&mut self, socket: u32, address: SocketAddr) -> io::Result<()> {
        #[cfg(unix)]
        self.socket(socket)?.set_reuse_address(true)?;
        self.socket(socket)?.bind(&address.into())
    }
    fn listen(&mut self, socket: u32) -> io::Result<()> {
        self.socket(socket)?.listen(128)
    }
    fn connect(&mut self, socket: u32, address: SocketAddr) -> io::Result<()> {
        self.socket(socket)?.set_tcp_nodelay(true)?;
        match self.socket(socket)?.connect(&address.into()) {
            Err(error) if in_progress(&error) => Err(io::ErrorKind::WouldBlock.into()),
            result => result,
        }
    }
    fn connected(&mut self, socket: u32) -> io::Result<()> {
        let socket = self.socket(socket)?;
        if let Some(error) = socket.take_error()? {
            return Err(error);
        }
        match socket.peer_addr() {
            Ok(_) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotConnected => {
                Err(io::ErrorKind::WouldBlock.into())
            }
            Err(error) => Err(error),
        }
    }
    fn accept(&mut self, socket: u32) -> io::Result<u32> {
        let (accepted, _) = self.socket(socket)?.accept()?;
        accepted.set_tcp_nodelay(true)?;
        self.insert(accepted)
    }
    fn read(&mut self, socket: u32, bytes: &mut [u8]) -> io::Result<usize> {
        self.socket(socket)?.read(bytes)
    }
    fn write(&mut self, socket: u32, bytes: &[u8]) -> io::Result<usize> {
        self.socket(socket)?.write(bytes)
    }
    fn shutdown(&mut self, socket: u32) -> io::Result<()> {
        self.socket(socket)?.shutdown(Shutdown::Write)
    }
    fn local_addr(&mut self, socket: u32) -> io::Result<SocketAddr> {
        address(self.socket(socket)?.local_addr()?)
    }
    fn peer_addr(&mut self, socket: u32) -> io::Result<SocketAddr> {
        address(self.socket(socket)?.peer_addr()?)
    }
    fn close(&mut self, socket: u32) {
        self.sockets.remove(&socket);
    }
}

fn address(address: socket2::SockAddr) -> io::Result<SocketAddr> {
    address
        .as_socket()
        .ok_or_else(|| io::ErrorKind::InvalidData.into())
}

fn in_progress(error: &io::Error) -> bool {
    #[cfg(unix)]
    {
        error.raw_os_error() == Some(libc::EINPROGRESS) || error.kind() == io::ErrorKind::WouldBlock
    }
    #[cfg(windows)]
    {
        error.raw_os_error() == Some(10035) || error.raw_os_error() == Some(10036)
    }
}

impl NativeHost {
    /// Reference implementation of the module's single import. Validate memory at this boundary.
    pub fn dispatch(
        &mut self,
        operation: u32,
        socket: u32,
        pointer: u32,
        length: u32,
        memory: &mut [u8],
    ) -> i32 {
        match self.dispatch_io(operation, socket, pointer, length, memory) {
            Ok(value) => value as i32,
            Err(error) => crate::abi::encode_error(&error),
        }
    }

    fn address_for(&mut self, operation: u32, socket: u32) -> io::Result<SocketAddr> {
        if operation == crate::abi::LOCAL_ADDR {
            return self.local_addr(socket);
        }
        self.peer_addr(socket)
    }

    fn dispatch_io(
        &mut self,
        operation: u32,
        socket: u32,
        pointer: u32,
        length: u32,
        memory: &mut [u8],
    ) -> io::Result<u32> {
        use crate::abi::*;
        match operation {
            OPEN if socket == 4 || socket == 6 => self.open(socket == 6),
            DUAL_STACK => self.dual_stack(socket).map(|()| 0),
            BIND => self
                .bind(
                    socket,
                    decode_address(address_span(memory, pointer, length)?)?,
                )
                .map(|()| 0),
            LISTEN => self.listen(socket).map(|()| 0),
            CONNECT => self
                .connect(
                    socket,
                    decode_address(address_span(memory, pointer, length)?)?,
                )
                .map(|()| 0),
            CONNECTED => self.connected(socket).map(|()| 0),
            ACCEPT => self.accept(socket),
            READ => self
                .read(socket, span(memory, pointer, length)?)
                .map(|n| n as u32),
            WRITE => self
                .write(socket, span(memory, pointer, length)?)
                .map(|n| n as u32),
            SHUTDOWN => self.shutdown(socket).map(|()| 0),
            LOCAL_ADDR | PEER_ADDR => {
                let bytes = address_span(memory, pointer, length)?;
                let address = self.address_for(operation, socket)?;
                bytes.copy_from_slice(&encode_address(address));
                Ok(0)
            }
            CLOSE => {
                self.close(socket);
                Ok(0)
            }
            _ => Err(io::ErrorKind::InvalidInput.into()),
        }
    }
}

fn address_span(memory: &mut [u8], pointer: u32, length: u32) -> io::Result<&mut [u8]> {
    if length != crate::abi::ADDRESS_SIZE as u32 {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    span(memory, pointer, length)
}

fn span(memory: &mut [u8], pointer: u32, length: u32) -> io::Result<&mut [u8]> {
    let start = pointer as usize;
    let end = start
        .checked_add(length as usize)
        .ok_or(io::ErrorKind::InvalidInput)?;
    memory
        .get_mut(start..end)
        .ok_or_else(|| io::ErrorKind::InvalidInput.into())
}

/// A coalescing control notification. It carries no module, socket table or guest memory.
#[cfg(unix)]
#[derive(Clone)]
pub struct ControlWake(std::sync::Arc<std::os::unix::net::UnixStream>);

#[cfg(unix)]
impl ControlWake {
    pub fn wake(&self) -> io::Result<()> {
        match self.0.as_ref().write(&[1]) {
            Ok(0) => Err(io::ErrorKind::BrokenPipe.into()),
            Ok(_) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(()),
            Err(error) => Err(error),
        }
    }
}

/// One actor owns the read endpoint. Send commands before waking it, then rescan after wake.
#[cfg(unix)]
pub struct Readiness(std::os::unix::net::UnixStream);

#[cfg(unix)]
#[derive(Debug, Default)]
pub struct Ready {
    pub sockets: Vec<(u32, u32)>,
    pub control: bool,
}

#[cfg(unix)]
impl Readiness {
    pub fn new() -> io::Result<(Self, ControlWake)> {
        let (read, write) = std::os::unix::net::UnixStream::pair()?;
        read.set_nonblocking(true)?;
        write.set_nonblocking(true)?;
        Ok((Self(read), ControlWake(std::sync::Arc::new(write))))
    }

    fn consume(&mut self) -> io::Result<()> {
        let mut bytes = [0; 256];
        loop {
            match self.0.read(&mut bytes) {
                Ok(0) => return Err(io::ErrorKind::BrokenPipe.into()),
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(()),
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) => return Err(error),
            }
        }
    }
}

#[cfg(unix)]
impl NativeHost {
    /// Wait for every registered token and external commands in one OS call.
    /// The module actor owns this host throughout the wait; other threads use ControlWake only.
    pub fn wait_many(
        &self,
        interests: &[(u32, u32)],
        control: &mut Readiness,
        timeout: Option<std::time::Duration>,
    ) -> io::Result<Ready> {
        use std::os::fd::AsRawFd;
        let mut descriptors = vec![poll_descriptor(control.0.as_raw_fd(), 1)];
        let mut ids = Vec::new();
        for &(id, interest) in interests {
            if interest & !3 != 0 {
                return Err(io::ErrorKind::InvalidInput.into());
            }
            let socket = self.socket(id)?;
            if interest & 3 == 0 {
                continue;
            }
            ids.push(id);
            descriptors.push(poll_descriptor(socket.as_raw_fd(), interest));
        }
        poll_descriptors(&mut descriptors, timeout)?;
        let woken = descriptors[0].revents != 0;
        if woken {
            control.consume()?;
        }
        let sockets = ids
            .into_iter()
            .zip(&descriptors[1..])
            .filter_map(|(id, descriptor)| {
                let bits = ready_bits(descriptor.revents);
                (bits != 0).then_some((id, bits))
            })
            .collect();
        Ok(Ready {
            sockets,
            control: woken,
        })
    }

    pub fn wait_ready(
        &self,
        id: u32,
        interests: u32,
        timeout: std::time::Duration,
    ) -> io::Result<u32> {
        use std::os::fd::AsRawFd;
        let mut descriptors = [poll_descriptor(self.socket(id)?.as_raw_fd(), interests)];
        poll_descriptors(&mut descriptors, Some(timeout))?;
        Ok(ready_bits(descriptors[0].revents))
    }
}

#[cfg(unix)]
fn poll_descriptor(fd: std::os::fd::RawFd, interests: u32) -> libc::pollfd {
    libc::pollfd {
        fd,
        events: if interests & 1 != 0 { libc::POLLIN } else { 0 }
            | if interests & 2 != 0 { libc::POLLOUT } else { 0 },
        revents: 0,
    }
}

#[cfg(unix)]
fn ready_bits(events: i16) -> u32 {
    u32::from(events & libc::POLLIN != 0)
        | (u32::from(events & libc::POLLOUT != 0) << 1)
        | (u32::from(events & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0) << 2)
}

#[cfg(unix)]
fn poll_descriptors(
    descriptors: &mut [libc::pollfd],
    timeout: Option<std::time::Duration>,
) -> io::Result<()> {
    let deadline = timeout.map(|duration| std::time::Instant::now() + duration);
    loop {
        let millis = deadline.map_or(-1, |deadline| {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            remaining
                .as_millis()
                .saturating_add(u128::from(remaining.subsec_nanos() % 1_000_000 != 0))
                .min(i32::MAX as u128) as i32
        });
        // Every descriptor stays owned by the actor; poll retains no array or descriptor pointer.
        let result = unsafe {
            libc::poll(
                descriptors.as_mut_ptr(),
                descriptors.len() as libc::nfds_t,
                millis,
            )
        };
        if result >= 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

fn socket_error(error: io::Error) -> io::Error {
    #[cfg(unix)]
    if matches!(
        error.raw_os_error(),
        Some(libc::EAFNOSUPPORT | libc::EPROTONOSUPPORT)
    ) {
        return io::Error::new(io::ErrorKind::Unsupported, error);
    }
    error
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outgoing_and_accepted_connections_enable_nodelay() {
        let mut host = NativeHost::default();
        let listener = host.open(false).unwrap();
        host.bind(listener, "127.0.0.1:0".parse().unwrap()).unwrap();
        host.listen(listener).unwrap();
        let address = host.local_addr(listener).unwrap();
        let outgoing = host.open(false).unwrap();
        let result = host.connect(outgoing, address);
        assert!(result.is_ok() || result.unwrap_err().kind() == io::ErrorKind::WouldBlock);
        assert!(host.socket(outgoing).unwrap().tcp_nodelay().unwrap());
        #[cfg(unix)]
        host.wait_ready(listener, 1, std::time::Duration::from_secs(3))
            .unwrap();
        let accepted = host.accept(listener).unwrap();
        assert!(host.socket(accepted).unwrap().tcp_nodelay().unwrap());
    }
}
