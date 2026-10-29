use crate::{SocketHost, SocketId, Tcp, abi::*};
use std::cell::RefCell;
use std::io;
use std::net::SocketAddr;

#[link(wasm_import_module = "waffle_tcp_host")]
unsafe extern "C" {
    fn io(operation: u32, socket: u32, pointer: u32, length: u32) -> i32;
}

struct ImportedHost;
fn call(operation: u32, socket: u32, pointer: u32, length: u32) -> io::Result<u32> {
    // Every pointer below refers to a live local array or slice for this synchronous call.
    let result = unsafe { io(operation, socket, pointer, length) };
    if result < 0 {
        return Err(decode_error(result));
    }
    Ok(result as u32)
}
fn address_call(operation: u32, socket: u32, address: SocketAddr) -> io::Result<()> {
    let bytes = encode_address(address);
    call(
        operation,
        socket,
        bytes.as_ptr() as u32,
        ADDRESS_SIZE as u32,
    )
    .map(|_| ())
}
fn read_address(operation: u32, socket: u32) -> io::Result<SocketAddr> {
    let mut bytes = [0; ADDRESS_SIZE];
    call(
        operation,
        socket,
        bytes.as_mut_ptr() as u32,
        ADDRESS_SIZE as u32,
    )?;
    decode_address(&bytes)
}
impl SocketHost for ImportedHost {
    fn open(&mut self, ipv6: bool) -> io::Result<u32> {
        call(OPEN, if ipv6 { 6 } else { 4 }, 0, 0)
    }
    fn dual_stack(&mut self, socket: u32) -> io::Result<()> {
        call(DUAL_STACK, socket, 0, 0).map(|_| ())
    }
    fn bind(&mut self, socket: u32, address: SocketAddr) -> io::Result<()> {
        address_call(BIND, socket, address)
    }
    fn listen(&mut self, socket: u32) -> io::Result<()> {
        call(LISTEN, socket, 0, 0).map(|_| ())
    }
    fn connect(&mut self, socket: u32, address: SocketAddr) -> io::Result<()> {
        address_call(CONNECT, socket, address)
    }
    fn connected(&mut self, socket: u32) -> io::Result<()> {
        call(CONNECTED, socket, 0, 0).map(|_| ())
    }
    fn accept(&mut self, socket: u32) -> io::Result<u32> {
        call(ACCEPT, socket, 0, 0)
    }
    fn read(&mut self, socket: u32, bytes: &mut [u8]) -> io::Result<usize> {
        call(READ, socket, bytes.as_mut_ptr() as u32, bytes.len() as u32).map(|n| n as usize)
    }
    fn write(&mut self, socket: u32, bytes: &[u8]) -> io::Result<usize> {
        call(WRITE, socket, bytes.as_ptr() as u32, bytes.len() as u32).map(|n| n as usize)
    }
    fn shutdown(&mut self, socket: u32) -> io::Result<()> {
        call(SHUTDOWN, socket, 0, 0).map(|_| ())
    }
    fn local_addr(&mut self, socket: u32) -> io::Result<SocketAddr> {
        read_address(LOCAL_ADDR, socket)
    }
    fn peer_addr(&mut self, socket: u32) -> io::Result<SocketAddr> {
        read_address(PEER_ADDR, socket)
    }
    fn close(&mut self, socket: u32) {
        let _ = call(CLOSE, socket, 0, 0);
    }
}

struct Module {
    tcp: Tcp<ImportedHost>,
    net: crate::virtual_net::VirtualNet,
    buffer: Box<[u8; BUFFER_SIZE]>,
}
thread_local! {
    static MODULE: RefCell<Module> = RefCell::new(Module { tcp: Tcp::new(ImportedHost), net: Default::default(), buffer: Box::new([0; BUFFER_SIZE]) });
}
fn run(operation: impl FnOnce(&mut Module) -> io::Result<u32>) -> i32 {
    MODULE.with(|module| match operation(&mut module.borrow_mut()) {
        Ok(value) => value as i32,
        Err(error) => encode_error(&error),
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn tcp_buffer() -> u32 {
    MODULE.with(|module| module.borrow().buffer.as_ptr() as u32)
}
#[unsafe(no_mangle)]
pub extern "C" fn tcp_capacity() -> u32 {
    BUFFER_SIZE as u32
}
#[unsafe(no_mangle)]
pub extern "C" fn tcp_listen_default(port: u32) -> i32 {
    run(|module| {
        module
            .tcp
            .listen_default(u16::try_from(port).map_err(|_| io::ErrorKind::InvalidInput)?)
            .map(|id| id.0)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn tcp_listen() -> i32 {
    run(|module| {
        module
            .tcp
            .listen(decode_address(&module.buffer[..ADDRESS_SIZE])?)
            .map(|id| id.0)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn tcp_connect() -> i32 {
    run(|module| {
        module
            .tcp
            .connect(decode_address(&module.buffer[..ADDRESS_SIZE])?)
            .map(|id| id.0)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn tcp_accept(socket: u32) -> i32 {
    run(|module| module.tcp.accept(SocketId(socket)).map(|id| id.0))
}
#[unsafe(no_mangle)]
pub extern "C" fn tcp_read(socket: u32, length: u32) -> i32 {
    run(|module| {
        let bytes = module
            .buffer
            .get_mut(..length as usize)
            .ok_or(io::ErrorKind::InvalidInput)?;
        module.tcp.read(SocketId(socket), bytes).map(|n| n as u32)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn tcp_write(socket: u32, length: u32) -> i32 {
    run(|module| {
        let bytes = module
            .buffer
            .get(..length as usize)
            .ok_or(io::ErrorKind::InvalidInput)?;
        module.tcp.write(SocketId(socket), bytes).map(|n| n as u32)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn tcp_shutdown(socket: u32) -> i32 {
    run(|module| module.tcp.shutdown(SocketId(socket)).map(|()| 0))
}
#[unsafe(no_mangle)]
pub extern "C" fn tcp_close(socket: u32) -> i32 {
    run(|module| module.tcp.close(SocketId(socket)).map(|()| 0))
}
#[unsafe(no_mangle)]
pub extern "C" fn tcp_local_addr(socket: u32) -> i32 {
    run(|module| {
        module.buffer[..ADDRESS_SIZE]
            .copy_from_slice(&encode_address(module.tcp.local_addr(SocketId(socket))?));
        Ok(ADDRESS_SIZE as u32)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn tcp_peer_addr(socket: u32) -> i32 {
    run(|module| {
        module.buffer[..ADDRESS_SIZE]
            .copy_from_slice(&encode_address(module.tcp.peer_addr(SocketId(socket))?));
        Ok(ADDRESS_SIZE as u32)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn tcp_dispose() -> i32 {
    MODULE.with(|module| {
        let mut module = module.borrow_mut();
        module.tcp.dispose();
        module.net.dispose();
    });
    0
}

fn virtual_addr(kind: u32, port: u32) -> io::Result<SocketAddr> {
    use std::net::{Ipv4Addr, Ipv6Addr};
    let ip = match kind {
        4 => Ipv4Addr::LOCALHOST.into(),
        6 => Ipv6Addr::LOCALHOST.into(),
        40 => Ipv4Addr::UNSPECIFIED.into(),
        60 => Ipv6Addr::UNSPECIFIED.into(),
        _ => return Err(io::ErrorKind::Unsupported.into()),
    };
    Ok(SocketAddr::new(
        ip,
        u16::try_from(port).map_err(|_| io::ErrorKind::InvalidInput)?,
    ))
}
#[unsafe(no_mangle)]
pub extern "C" fn net_listen(kind: u32, port: u32) -> i32 {
    run(|module| module.net.listen(virtual_addr(kind, port)?).map(u32::from))
}
#[unsafe(no_mangle)]
pub extern "C" fn net_unlisten(port: u32) -> i32 {
    run(|module| {
        module
            .net
            .unlisten(u16::try_from(port).map_err(|_| io::ErrorKind::InvalidInput)?);
        Ok(0)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn net_connect(kind: u32, port: u32) -> i32 {
    run(|module| module.net.connect(virtual_addr(kind, port)?))
}
#[unsafe(no_mangle)]
pub extern "C" fn net_pair() -> i32 {
    run(|module| module.net.pair())
}
#[unsafe(no_mangle)]
pub extern "C" fn net_peer(id: u32) -> i32 {
    run(|module| module.net.peer(id))
}
#[unsafe(no_mangle)]
pub extern "C" fn net_write(id: u32, length: u32) -> i32 {
    run(|module| {
        module
            .net
            .write(
                id,
                module
                    .buffer
                    .get(..length as usize)
                    .ok_or(io::ErrorKind::InvalidInput)?,
            )
            .map(|n| n as u32)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn net_take(id: u32, length: u32) -> i32 {
    run(|module| {
        module
            .net
            .take(
                id,
                module
                    .buffer
                    .get_mut(..length as usize)
                    .ok_or(io::ErrorKind::InvalidInput)?,
            )
            .map(|n| n as u32)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn net_consumed(id: u32, length: u32) -> i32 {
    run(|module| Ok(u32::from(module.net.consumed(id, length as usize))))
}
#[unsafe(no_mangle)]
pub extern "C" fn net_writable(id: u32) -> i32 {
    run(|module| Ok(u32::from(module.net.writable(id))))
}
#[unsafe(no_mangle)]
pub extern "C" fn net_ended(id: u32) -> i32 {
    run(|module| Ok(u32::from(module.net.ended(id))))
}
#[unsafe(no_mangle)]
pub extern "C" fn net_shutdown(id: u32) -> i32 {
    run(|module| module.net.shutdown(id).map(|()| 0))
}
#[unsafe(no_mangle)]
pub extern "C" fn net_close(id: u32) -> i32 {
    run(|module| {
        module.net.close(id);
        Ok(0)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn net_address(id: u32, peer: u32) -> i32 {
    run(|module| {
        let address = if peer == 0 {
            module.net.local_addr(id)?
        } else {
            module.net.peer_addr(id)?
        };
        module.buffer[..ADDRESS_SIZE].copy_from_slice(&encode_address(address));
        Ok(0)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn tcp_poll(id: u32) -> i32 {
    run(|module| module.tcp.poll(SocketId(id)).map(|()| 0))
}

#[unsafe(no_mangle)]
pub extern "C" fn tcp_interests(id: u32) -> i32 {
    run(|module| module.tcp.interests(SocketId(id)))
}

#[unsafe(no_mangle)]
pub extern "C" fn tcp_close_graceful(id: u32) -> i32 {
    run(|module| module.tcp.close_graceful(SocketId(id)).map(|()| 0))
}
#[unsafe(no_mangle)]
pub extern "C" fn tcp_close_status(id: u32) -> i32 {
    run(|module| module.tcp.close_status(SocketId(id)))
}
#[unsafe(no_mangle)]
pub extern "C" fn tcp_next(after: u32) -> i32 {
    run(|module| Ok(module.tcp.next_socket(after).map_or(0, |id| id.0)))
}
