//! Stable module wire values, independent of Bun and platform errno numbers.
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV6};

pub const BUFFER_SIZE: usize = 64 * 1024;
pub const ADDRESS_SIZE: usize = 32;

pub fn encode_error(error: &io::Error) -> i32 {
    use io::ErrorKind::*;
    -(match error.kind() {
        WouldBlock => 1,
        InvalidInput | InvalidData => 2,
        AddrInUse => 3,
        AddrNotAvailable => 4,
        ConnectionRefused => 5,
        BrokenPipe => 6,
        NotConnected => 7,
        PermissionDenied => 8,
        TimedOut => 9,
        Unsupported => 10,
        ConnectionReset => 11,
        ConnectionAborted => 12,
        HostUnreachable => 14,
        NetworkUnreachable => 15,
        NetworkDown => 16,
        _ => 13,
    })
}

pub fn decode_error(code: i32) -> io::Error {
    use io::ErrorKind::*;
    let kind = match -code {
        1 => WouldBlock,
        2 => InvalidInput,
        3 => AddrInUse,
        4 => AddrNotAvailable,
        5 => ConnectionRefused,
        6 => BrokenPipe,
        7 => NotConnected,
        8 => PermissionDenied,
        9 => TimedOut,
        10 => Unsupported,
        11 => ConnectionReset,
        12 => ConnectionAborted,
        14 => HostUnreachable,
        15 => NetworkUnreachable,
        16 => NetworkDown,
        _ => Other,
    };
    kind.into()
}

pub fn encode_address(address: SocketAddr) -> [u8; ADDRESS_SIZE] {
    let mut out = [0; ADDRESS_SIZE];
    out[..4].copy_from_slice(&if address.is_ipv4() { 4u32 } else { 6u32 }.to_le_bytes());
    out[4..8].copy_from_slice(&u32::from(address.port()).to_le_bytes());
    match address.ip() {
        IpAddr::V4(ip) => out[8..12].copy_from_slice(&ip.octets()),
        IpAddr::V6(ip) => out[8..24].copy_from_slice(&ip.octets()),
    }
    if let SocketAddr::V6(address) = address {
        out[24..28].copy_from_slice(&address.flowinfo().to_le_bytes());
        out[28..32].copy_from_slice(&address.scope_id().to_le_bytes());
    }
    out
}

pub fn decode_address(bytes: &[u8]) -> io::Result<SocketAddr> {
    let bytes: &[u8; ADDRESS_SIZE] = bytes.try_into().map_err(|_| io::ErrorKind::InvalidInput)?;
    let port = u16::try_from(u32::from_le_bytes(bytes[4..8].try_into().unwrap()))
        .map_err(|_| io::ErrorKind::InvalidInput)?;
    let ip: IpAddr = match u32::from_le_bytes(bytes[..4].try_into().unwrap()) {
        4 => Ipv4Addr::from(<[u8; 4]>::try_from(&bytes[8..12]).unwrap()).into(),
        6 => Ipv6Addr::from(<[u8; 16]>::try_from(&bytes[8..24]).unwrap()).into(),
        _ => return Err(io::ErrorKind::InvalidInput.into()),
    };
    if let IpAddr::V6(ip) = ip {
        let flow = u32::from_le_bytes(bytes[24..28].try_into().unwrap());
        let scope = u32::from_le_bytes(bytes[28..32].try_into().unwrap());
        return Ok(SocketAddr::V6(SocketAddrV6::new(ip, port, flow, scope)));
    }
    Ok(SocketAddr::new(ip, port))
}

// The module imports one synchronous call. These operation numbers are its ABI.
pub const OPEN: u32 = 1;
pub const DUAL_STACK: u32 = 2;
pub const BIND: u32 = 3;
pub const LISTEN: u32 = 4;
pub const CONNECT: u32 = 5;
pub const CONNECTED: u32 = 6;
pub const ACCEPT: u32 = 7;
pub const READ: u32 = 8;
pub const WRITE: u32 = 9;
pub const SHUTDOWN: u32 = 10;
pub const LOCAL_ADDR: u32 = 11;
pub const PEER_ADDR: u32 = 12;
pub const CLOSE: u32 = 13;
