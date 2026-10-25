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
        self.socket(socket)?.bind(&address.into())
    }
    fn listen(&mut self, socket: u32) -> io::Result<()> {
        self.socket(socket)?.listen(128)
    }
    fn connect(&mut self, socket: u32, address: SocketAddr) -> io::Result<()> {
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
                    decode_address(span(memory, pointer, ADDRESS_SIZE as u32)?)?,
                )
                .map(|()| 0),
            LISTEN => self.listen(socket).map(|()| 0),
            CONNECT => self
                .connect(
                    socket,
                    decode_address(span(memory, pointer, ADDRESS_SIZE as u32)?)?,
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
                let address = self.address_for(operation, socket)?;
                span(memory, pointer, ADDRESS_SIZE as u32)?
                    .copy_from_slice(&encode_address(address));
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

fn span(memory: &mut [u8], pointer: u32, length: u32) -> io::Result<&mut [u8]> {
    let start = pointer as usize;
    let end = start
        .checked_add(length as usize)
        .ok_or(io::ErrorKind::InvalidInput)?;
    memory
        .get_mut(start..end)
        .ok_or_else(|| io::ErrorKind::InvalidInput.into())
}

#[cfg(unix)]
impl NativeHost {
    /// Readiness belongs to the OS event loop, outside WASM. Bits: readable=1, writable=2,
    /// terminal=4. After notification the embedder calls tcp_poll or tcp_accept in WASM.
    pub fn wait_ready(
        &self,
        id: u32,
        interests: u32,
        timeout: std::time::Duration,
    ) -> io::Result<u32> {
        use std::os::fd::AsRawFd;
        let events = if interests & 1 != 0 { libc::POLLIN } else { 0 }
            | if interests & 2 != 0 { libc::POLLOUT } else { 0 };
        let mut descriptor = libc::pollfd {
            fd: self.socket(id)?.as_raw_fd(),
            events,
            revents: 0,
        };
        let millis = timeout.as_millis().min(i32::MAX as u128) as i32;
        // poll borrows this live descriptor and retains neither it nor the array pointer.
        let result = unsafe { libc::poll(&mut descriptor, 1, millis) };
        if result < 0 {
            return Err(io::Error::last_os_error());
        }
        let mut ready = 0;
        if descriptor.revents & libc::POLLIN != 0 {
            ready |= 1;
        }
        if descriptor.revents & libc::POLLOUT != 0 {
            ready |= 2;
        }
        if descriptor.revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
            ready |= 4;
        }
        Ok(ready)
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
