//! Browser virtual-only namespace. There is no route from this state to OS imports.
use crate::queue::ByteQueue;
use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

pub const LIMIT: usize = 1 << 20;
const FIRST_PORT: u16 = 49152;
struct Endpoint {
    peer: u32,
    /// Local and remote TCP addresses; None for an addressless path pair.
    addresses: Option<(SocketAddr, SocketAddr)>,
    received: ByteQueue,
    in_flight: usize,
    write_ended: bool,
    closed: bool,
}
#[derive(Default)]
pub struct VirtualNet {
    listeners: BTreeMap<u16, SocketAddr>,
    clients: BTreeSet<u16>,
    endpoints: BTreeMap<u32, Endpoint>,
    next: u32,
    next_port: u16,
}
impl VirtualNet {
    pub fn listen(&mut self, address: SocketAddr) -> io::Result<u16> {
        virtual_address(address.ip())?;
        let port = if address.port() == 0 {
            self.available(FIRST_PORT)?
        } else {
            address.port()
        };
        if self.listeners.contains_key(&port) || self.clients.contains(&port) {
            return Err(io::ErrorKind::AddrInUse.into());
        }
        self.listeners
            .insert(port, SocketAddr::new(address.ip(), port));
        Ok(port)
    }
    pub fn dispose(&mut self) {
        self.listeners.clear();
        self.clients.clear();
        self.endpoints.clear();
    }
    pub fn unlisten(&mut self, port: u16) {
        self.listeners.remove(&port);
    }
    fn available(&self, start: u16) -> io::Result<u16> {
        for offset in 0..16384u32 {
            let port = FIRST_PORT
                + ((u32::from(start.max(FIRST_PORT) - FIRST_PORT) + offset) % 16384) as u16;
            if !self.listeners.contains_key(&port) && !self.clients.contains(&port) {
                return Ok(port);
            }
        }
        Err(io::ErrorKind::AddrNotAvailable.into())
    }
    pub fn connect(&mut self, target: SocketAddr) -> io::Result<u32> {
        virtual_address(target.ip())?;
        let bind = *self
            .listeners
            .get(&target.port())
            .ok_or(io::ErrorKind::ConnectionRefused)?;
        let ip = accepted_ip(bind.ip(), target.ip())?;
        let port = self.available(self.next_port)?;
        let client = self.ids()?;
        self.next_port = if port == 65535 { FIRST_PORT } else { port + 1 };
        self.clients.insert(port);
        let dialing = SocketAddr::new(loopback(target.ip()), port);
        let bound = SocketAddr::new(loopback(target.ip()), target.port());
        self.insert_pair(
            client,
            Some((dialing, bound)),
            Some((
                SocketAddr::new(ip, target.port()),
                SocketAddr::new(ip, port),
            )),
        );
        Ok(client)
    }
    /// Addressless connected pair for pathname sockets. Returns the dialing (odd) id.
    pub fn pair(&mut self) -> io::Result<u32> {
        let client = self.ids()?;
        self.insert_pair(client, None, None);
        Ok(client)
    }
    fn ids(&mut self) -> io::Result<u32> {
        let client = self
            .next
            .checked_add(1)
            .filter(|id| *id < i32::MAX as u32 - 1)
            .ok_or(io::ErrorKind::OutOfMemory)?;
        self.next = client + 1;
        Ok(client)
    }
    fn insert_pair(
        &mut self,
        client: u32,
        dialing: Option<(SocketAddr, SocketAddr)>,
        accepted: Option<(SocketAddr, SocketAddr)>,
    ) {
        self.endpoints.insert(client, endpoint(client + 1, dialing));
        self.endpoints
            .insert(client + 1, endpoint(client, accepted));
    }
    fn endpoint(&self, id: u32) -> io::Result<&Endpoint> {
        self.endpoints
            .get(&id)
            .filter(|endpoint| !endpoint.closed)
            .ok_or_else(|| io::ErrorKind::InvalidInput.into())
    }
    pub fn peer(&self, id: u32) -> io::Result<u32> {
        Ok(self.endpoint(id)?.peer)
    }
    fn addresses(&self, id: u32) -> io::Result<(SocketAddr, SocketAddr)> {
        self.endpoint(id)?
            .addresses
            .ok_or_else(|| io::ErrorKind::Unsupported.into())
    }
    pub fn local_addr(&self, id: u32) -> io::Result<SocketAddr> {
        Ok(self.addresses(id)?.0)
    }
    pub fn peer_addr(&self, id: u32) -> io::Result<SocketAddr> {
        Ok(self.addresses(id)?.1)
    }
    pub fn write(&mut self, id: u32, bytes: &[u8]) -> io::Result<usize> {
        let source = self.endpoint(id)?;
        if source.write_ended {
            return Err(io::ErrorKind::BrokenPipe.into());
        }
        let peer = source.peer;
        let target = self
            .endpoints
            .get_mut(&peer)
            .filter(|endpoint| !endpoint.closed)
            .ok_or(io::ErrorKind::BrokenPipe)?;
        let count = bytes.len().min(LIMIT - target.in_flight);
        if count == 0 && !bytes.is_empty() {
            return Err(io::ErrorKind::WouldBlock.into());
        }
        target.in_flight += count;
        target.received.push(&bytes[..count]);
        Ok(count)
    }
    // Ring publication copies bytes; only consumed releases their outstanding credit.
    pub fn take(&mut self, id: u32, bytes: &mut [u8]) -> io::Result<usize> {
        self.endpoint(id)?;
        let endpoint = self.endpoints.get_mut(&id).unwrap();
        Ok(endpoint.received.take(bytes))
    }
    pub fn consumed(&mut self, id: u32, count: usize) -> bool {
        let Some(endpoint) = self
            .endpoints
            .get_mut(&id)
            .filter(|endpoint| !endpoint.closed)
        else {
            return false;
        };
        let full = endpoint.in_flight == LIMIT;
        endpoint.in_flight = endpoint.in_flight.saturating_sub(count);
        full && endpoint.in_flight < LIMIT
    }
    pub fn writable(&self, id: u32) -> bool {
        let Ok(endpoint) = self.endpoint(id) else {
            return true;
        };
        self.endpoints
            .get(&endpoint.peer)
            .is_none_or(|peer| peer.closed || peer.in_flight < LIMIT)
    }
    pub fn ended(&self, id: u32) -> bool {
        let Ok(endpoint) = self.endpoint(id) else {
            return true;
        };
        self.endpoints
            .get(&endpoint.peer)
            .is_none_or(|peer| peer.write_ended)
    }
    pub fn shutdown(&mut self, id: u32) -> io::Result<()> {
        self.endpoint(id)?;
        self.endpoints.get_mut(&id).unwrap().write_ended = true;
        Ok(())
    }
    pub fn close(&mut self, id: u32) {
        let Some(endpoint) = self.endpoints.get_mut(&id) else {
            return;
        };
        endpoint.closed = true;
        endpoint.write_ended = true;
        endpoint.received = ByteQueue::default();
        let peer = endpoint.peer;
        // The odd token is the dialing endpoint and owns the ephemeral port.
        if let (1, Some((local, _))) = (id % 2, endpoint.addresses) {
            self.clients.remove(&local.port());
        }
        if self
            .endpoints
            .get(&peer)
            .is_some_and(|endpoint| !endpoint.closed)
        {
            return;
        }
        self.endpoints.remove(&id);
        self.endpoints.remove(&peer);
    }
}
fn endpoint(peer: u32, addresses: Option<(SocketAddr, SocketAddr)>) -> Endpoint {
    Endpoint {
        peer,
        addresses,
        received: ByteQueue::default(),
        in_flight: 0,
        write_ended: false,
        closed: false,
    }
}
fn virtual_address(ip: IpAddr) -> io::Result<()> {
    if ip.is_unspecified()
        || ip == IpAddr::V4(Ipv4Addr::LOCALHOST)
        || ip == IpAddr::V6(Ipv6Addr::LOCALHOST)
    {
        return Ok(());
    }
    Err(io::ErrorKind::Unsupported.into())
}
fn loopback(ip: IpAddr) -> IpAddr {
    if ip.is_ipv4() {
        Ipv4Addr::LOCALHOST.into()
    } else {
        Ipv6Addr::LOCALHOST.into()
    }
}
fn accepted_ip(bind: IpAddr, target: IpAddr) -> io::Result<IpAddr> {
    if bind.is_ipv4() == target.is_ipv4() {
        return Ok(loopback(target));
    }
    if bind == IpAddr::V6(Ipv6Addr::UNSPECIFIED) {
        return Ok(Ipv4Addr::LOCALHOST.to_ipv6_mapped().into());
    }
    Err(io::ErrorKind::ConnectionRefused.into())
}
