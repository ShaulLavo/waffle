//! Browser virtual-only namespace. There is no route from this state to OS imports.
//!
//! Every table is allocated once, when the namespace is created. After that the only allocation
//! a virtual operation can make is one queue chunk, taken from a counted pool that never returns
//! memory to the allocator. A refused resource is a status, never an allocator failure.
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

pub const LIMIT: usize = 1 << 20;
const FIRST_PORT: u16 = 49152;
const PORTS: usize = 16384;
/// Live endpoint records. A closed half stays charged until its peer closes too.
pub const ENDPOINTS: usize = 512;
/// Live TCP listeners.
pub const LISTENERS: usize = 1024;
pub const CHUNK: usize = 1 << 16;
/// A queue of at most LIMIT bytes that starts anywhere in its first chunk spans this many.
const SPAN: usize = LIMIT / CHUNK + 1;
/// Every live endpoint can hold a full queue at once, so a write never waits for the pool.
pub const CHUNKS: usize = ENDPOINTS * SPAN;
/// Chunks are carved from slabs of this many, allocated one at a time and never freed.
const SLAB_CHUNKS: usize = 64;
const SLABS: usize = CHUNKS / SLAB_CHUNKS;
/// No slab is allocated unless linear memory stays within 1 GiB, in 64 KiB pages.
pub const ENVELOPE_PAGES: usize = 16_384;
/// Established for the pinned dlmalloc artifact by the complete 136-slab growth gate.
/// Not a Rust allocator guarantee; producer/toolchain changes invalidate that gate.
#[cfg(target_arch = "wasm32")]
const SLAB_GROWTH_PAGES: usize = SLAB_CHUNKS + 1;
const _: () = assert!(CHUNKS.is_multiple_of(SLAB_CHUNKS) && CHUNKS <= u16::MAX as usize);

/// Counted chunk storage. `issued` only rises; released chunks wait in `free` for reuse.
struct Pool {
    slabs: Vec<Box<[u8]>>,
    free: Vec<u16>,
    issued: usize,
}
impl Pool {
    fn take(&mut self) -> Option<u16> {
        if let Some(chunk) = self.free.pop() {
            return Some(chunk);
        }
        if self.issued == self.slabs.len() * SLAB_CHUNKS && !self.grow() {
            return None;
        }
        self.issued += 1;
        Some((self.issued - 1) as u16)
    }
    /// The one allocation a virtual operation can make. Refused before it is tried when the
    /// count or the envelope forbids it, and when the allocator reports it has no memory.
    fn grow(&mut self) -> bool {
        if self.slabs.len() == SLABS || !envelope_has_room() {
            return false;
        }
        let mut slab = Vec::new();
        if slab.try_reserve_exact(SLAB_CHUNKS * CHUNK).is_err() {
            return false;
        }
        slab.resize(SLAB_CHUNKS * CHUNK, 0);
        self.slabs.push(slab.into_boxed_slice());
        true
    }
    /// `free` was created with room for every chunk, so this never allocates.
    fn give(&mut self, chunk: u16) {
        self.free.push(chunk);
    }
    fn bytes(&mut self, chunk: u16) -> &mut [u8] {
        let (slab, start) = (
            usize::from(chunk) / SLAB_CHUNKS,
            usize::from(chunk) % SLAB_CHUNKS,
        );
        &mut self.slabs[slab][start * CHUNK..(start + 1) * CHUNK]
    }
}
#[cfg(target_arch = "wasm32")]
fn envelope_has_room() -> bool {
    core::arch::wasm32::memory_size(0) + SLAB_GROWTH_PAGES <= ENVELOPE_PAGES
}
#[cfg(not(target_arch = "wasm32"))]
fn envelope_has_room() -> bool {
    true
}

/// Bytes received and not yet taken, in whole chunks named inline. An empty queue holds none.
#[derive(Default)]
struct Queue {
    chunks: [u16; SPAN],
    first: usize,
    count: usize,
    head: usize,
    len: usize,
}
impl Queue {
    /// Accepts a prefix: what fits below LIMIT and what the pool can back.
    fn push(&mut self, pool: &mut Pool, bytes: &[u8]) -> usize {
        let total = bytes.len().min(LIMIT - self.len);
        let mut done = 0;
        while done < total {
            let end = self.head + self.len;
            let (slot, offset) = (end / CHUNK, end % CHUNK);
            if slot == self.count && !self.extend(pool) {
                break;
            }
            let chunk = pool.bytes(self.chunks[(self.first + slot) % SPAN]);
            let count = (CHUNK - offset).min(total - done);
            chunk[offset..offset + count].copy_from_slice(&bytes[done..done + count]);
            done += count;
            self.len += count;
        }
        done
    }
    fn extend(&mut self, pool: &mut Pool) -> bool {
        let Some(chunk) = pool.take() else {
            return false;
        };
        self.chunks[(self.first + self.count) % SPAN] = chunk;
        self.count += 1;
        true
    }
    fn take(&mut self, pool: &mut Pool, out: &mut [u8]) -> usize {
        let total = out.len().min(self.len);
        let mut done = 0;
        while done < total {
            let chunk = pool.bytes(self.chunks[self.first]);
            let count = (CHUNK - self.head).min(total - done);
            out[done..done + count].copy_from_slice(&chunk[self.head..self.head + count]);
            done += count;
            self.head += count;
            self.len -= count;
            if self.head == CHUNK {
                self.release_first(pool);
            }
        }
        if self.len == 0 {
            self.clear(pool);
        }
        done
    }
    fn release_first(&mut self, pool: &mut Pool) {
        pool.give(self.chunks[self.first]);
        self.first = (self.first + 1) % SPAN;
        self.count -= 1;
        self.head = 0;
    }
    fn clear(&mut self, pool: &mut Pool) {
        while self.count > 0 {
            self.release_first(pool);
        }
        self.first = 0;
        self.len = 0;
    }
}

struct Endpoint {
    id: u32,
    peer: u32,
    /// Local and remote TCP addresses; None for an addressless path pair.
    addresses: Option<(SocketAddr, SocketAddr)>,
    received: Queue,
    in_flight: usize,
    write_ended: bool,
    closed: bool,
}
/// What the namespace currently holds, for tests and diagnostics. Counts, not bytes of memory.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct Usage {
    pub endpoints: usize,
    pub listeners: usize,
    pub chunks_issued: usize,
    pub chunks_free: usize,
}
pub struct VirtualNet {
    /// Sorted by port.
    listeners: Vec<(u16, SocketAddr)>,
    /// One bit per ephemeral port held by a dialing endpoint.
    clients: [u64; PORTS / 64],
    /// Sorted by id; ids only rise, so a new pair is appended.
    endpoints: Vec<Endpoint>,
    pool: Pool,
    next: u32,
    next_port: u16,
}
impl Default for VirtualNet {
    fn default() -> Self {
        Self {
            listeners: Vec::with_capacity(LISTENERS),
            clients: [0; PORTS / 64],
            endpoints: Vec::with_capacity(ENDPOINTS),
            pool: Pool {
                slabs: Vec::with_capacity(SLABS),
                free: Vec::with_capacity(CHUNKS),
                issued: 0,
            },
            next: 0,
            next_port: 0,
        }
    }
}
fn quota() -> io::Error {
    io::ErrorKind::QuotaExceeded.into()
}
impl VirtualNet {
    pub fn usage(&self) -> Usage {
        Usage {
            endpoints: self.endpoints.len(),
            listeners: self.listeners.len(),
            chunks_issued: self.pool.issued,
            chunks_free: self.pool.free.len(),
        }
    }
    fn listener(&self, port: u16) -> Result<usize, usize> {
        self.listeners.binary_search_by_key(&port, |entry| entry.0)
    }
    fn client(&self, port: u16) -> bool {
        let Some(bit) = port.checked_sub(FIRST_PORT).map(usize::from) else {
            return false;
        };
        self.clients[bit / 64] & (1 << (bit % 64)) != 0
    }
    fn set_client(&mut self, port: u16, held: bool) {
        let bit = usize::from(port - FIRST_PORT);
        if held {
            self.clients[bit / 64] |= 1 << (bit % 64);
        } else {
            self.clients[bit / 64] &= !(1 << (bit % 64));
        }
    }
    pub fn listen(&mut self, address: SocketAddr) -> io::Result<u16> {
        virtual_address(address.ip())?;
        let port = if address.port() == 0 {
            self.available(FIRST_PORT)?
        } else {
            address.port()
        };
        let Err(position) = self.listener(port) else {
            return Err(io::ErrorKind::AddrInUse.into());
        };
        if self.client(port) {
            return Err(io::ErrorKind::AddrInUse.into());
        }
        if self.listeners.len() == LISTENERS {
            return Err(quota());
        }
        self.listeners
            .insert(position, (port, SocketAddr::new(address.ip(), port)));
        Ok(port)
    }
    pub fn dispose(&mut self) {
        self.listeners.clear();
        self.clients = [0; PORTS / 64];
        for endpoint in &mut self.endpoints {
            endpoint.received.clear(&mut self.pool);
        }
        self.endpoints.clear();
    }
    pub fn unlisten(&mut self, port: u16) {
        if let Ok(position) = self.listener(port) {
            self.listeners.remove(position);
        }
    }
    fn available(&self, start: u16) -> io::Result<u16> {
        for offset in 0..PORTS as u32 {
            let port = FIRST_PORT
                + ((u32::from(start.max(FIRST_PORT) - FIRST_PORT) + offset) % PORTS as u32) as u16;
            if self.listener(port).is_err() && !self.client(port) {
                return Ok(port);
            }
        }
        Err(io::ErrorKind::AddrNotAvailable.into())
    }
    pub fn connect(&mut self, target: SocketAddr) -> io::Result<u32> {
        virtual_address(target.ip())?;
        let bind = self
            .listener(target.port())
            .map(|position| self.listeners[position].1)
            .map_err(|_| io::ErrorKind::ConnectionRefused)?;
        let ip = accepted_ip(bind.ip(), target.ip())?;
        let port = self.available(self.next_port)?;
        let client = self.ids()?;
        self.next_port = if port == 65535 { FIRST_PORT } else { port + 1 };
        self.set_client(port, true);
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
    /// Admission for a pair: two free records, before any id or port is taken.
    fn ids(&mut self) -> io::Result<u32> {
        if self.endpoints.len() + 2 > ENDPOINTS {
            return Err(quota());
        }
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
        self.endpoints.push(endpoint(client, client + 1, dialing));
        self.endpoints.push(endpoint(client + 1, client, accepted));
    }
    fn position(&self, id: u32) -> Option<usize> {
        self.endpoints
            .binary_search_by_key(&id, |endpoint| endpoint.id)
            .ok()
    }
    /// A live (not closed) endpoint.
    fn open(&self, id: u32) -> Option<usize> {
        self.position(id)
            .filter(|position| !self.endpoints[*position].closed)
    }
    fn endpoint(&self, id: u32) -> io::Result<&Endpoint> {
        self.open(id)
            .map(|position| &self.endpoints[position])
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
        let position = self.open(source.peer).ok_or(io::ErrorKind::BrokenPipe)?;
        let target = &mut self.endpoints[position];
        let credit = bytes
            .len()
            .min(LIMIT - target.in_flight)
            .min(LIMIT - target.received.len);
        if credit == 0 && !bytes.is_empty() {
            return Err(io::ErrorKind::WouldBlock.into());
        }
        let count = target.received.push(&mut self.pool, &bytes[..credit]);
        // Credit was available but the pool could not back a single byte.
        if count == 0 && credit > 0 {
            return Err(quota());
        }
        target.in_flight += count;
        Ok(count)
    }
    // Ring publication copies bytes; only consumed releases their outstanding credit.
    pub fn take(&mut self, id: u32, bytes: &mut [u8]) -> io::Result<usize> {
        let position = self.open(id).ok_or(io::ErrorKind::InvalidInput)?;
        Ok(self.endpoints[position]
            .received
            .take(&mut self.pool, bytes))
    }
    pub fn consumed(&mut self, id: u32, count: usize) -> bool {
        let Some(position) = self.open(id) else {
            return false;
        };
        let endpoint = &mut self.endpoints[position];
        let full = endpoint.in_flight == LIMIT;
        endpoint.in_flight = endpoint
            .in_flight
            .saturating_sub(count)
            .max(endpoint.received.len);
        full && endpoint.in_flight < LIMIT
    }
    pub fn writable(&self, id: u32) -> bool {
        let Ok(endpoint) = self.endpoint(id) else {
            return true;
        };
        self.open(endpoint.peer)
            .is_none_or(|position| self.endpoints[position].in_flight < LIMIT)
    }
    pub fn ended(&self, id: u32) -> bool {
        let Ok(endpoint) = self.endpoint(id) else {
            return true;
        };
        self.position(endpoint.peer)
            .is_none_or(|position| self.endpoints[position].write_ended)
    }
    pub fn shutdown(&mut self, id: u32) -> io::Result<()> {
        let position = self.open(id).ok_or(io::ErrorKind::InvalidInput)?;
        self.endpoints[position].write_ended = true;
        Ok(())
    }
    pub fn close(&mut self, id: u32) {
        let Some(position) = self.open(id) else {
            return;
        };
        let endpoint = &mut self.endpoints[position];
        endpoint.closed = true;
        endpoint.write_ended = true;
        endpoint.received.clear(&mut self.pool);
        let peer = endpoint.peer;
        // The odd token is the dialing endpoint and owns the ephemeral port.
        if let (1, Some((local, _))) = (id % 2, endpoint.addresses) {
            self.set_client(local.port(), false);
        }
        if self.open(peer).is_some() {
            return;
        }
        // Both halves are closed and hold no chunks; the pair's ids are adjacent.
        let first = self.position(id.min(peer)).unwrap();
        self.endpoints.drain(first..first + 2);
    }
}
fn endpoint(id: u32, peer: u32, addresses: Option<(SocketAddr, SocketAddr)>) -> Endpoint {
    Endpoint {
        id,
        peer,
        addresses,
        received: Queue::default(),
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
