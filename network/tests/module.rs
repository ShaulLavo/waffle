mod support;
// Exercise the compiled module against the actual Waffle socket2 import binding.
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::thread;
use std::time::{Duration, Instant};
use waffle_tcp::{abi::*, native::NativeHost};
use wasmi::{Caller, Engine, Extern, Instance, Linker, Module, Store};

struct Guest {
    store: Store<NativeHost>,
    instance: Instance,
}
impl Guest {
    fn new() -> Self {
        Self::with_error(None)
    }
    fn with_error(failure: Option<(u32, i32)>) -> Self {
        let bytes =
            std::fs::read(std::env::var("WAFFLE_TCP_MODULE").expect("build the WASM module first"))
                .unwrap();
        let engine = Engine::default();
        let module = Module::new(&engine, bytes.as_slice()).unwrap();
        let mut store = Store::new(&engine, NativeHost::default());
        let mut linker = Linker::new(&engine);
        linker
            .func_wrap(
                "waffle_tcp_host",
                "io",
                move |mut caller: Caller<'_, NativeHost>, op: u32, id: u32, ptr: u32, len: u32| {
                    if let Some((operation, error)) = failure
                        && op == operation
                    {
                        return error;
                    }
                    let memory = caller
                        .get_export("memory")
                        .and_then(Extern::into_memory)
                        .unwrap();
                    let (memory, host) = memory.data_and_store_mut(&mut caller);
                    host.dispatch(
                        op,
                        id,
                        ptr,
                        if op == READ || op == WRITE {
                            len.min(2)
                        } else {
                            len
                        },
                        memory,
                    )
                },
            )
            .unwrap();
        let instance = linker
            .instantiate(&mut store, &module)
            .unwrap()
            .start(&mut store)
            .unwrap();
        Self { store, instance }
    }
    fn call(&mut self, name: &str, id: u32) -> i32 {
        self.instance
            .get_typed_func::<u32, i32>(&self.store, name)
            .unwrap()
            .call(&mut self.store, id)
            .unwrap()
    }
    fn zero(&mut self, name: &str) -> i32 {
        self.instance
            .get_typed_func::<(), i32>(&self.store, name)
            .unwrap()
            .call(&mut self.store, ())
            .unwrap()
    }
    fn io(&mut self, name: &str, id: u32, len: u32) -> i32 {
        self.instance
            .get_typed_func::<(u32, u32), i32>(&self.store, name)
            .unwrap()
            .call(&mut self.store, (id, len))
            .unwrap()
    }
    fn buffer(&mut self) -> &mut [u8] {
        let at = self
            .instance
            .get_typed_func::<(), u32>(&self.store, "tcp_buffer")
            .unwrap()
            .call(&mut self.store, ())
            .unwrap() as usize;
        let memory = self.instance.get_memory(&self.store, "memory").unwrap();
        &mut memory.data_mut(&mut self.store)[at..at + BUFFER_SIZE]
    }
    fn address(&mut self, id: u32, peer: bool) -> SocketAddr {
        let operation = if peer {
            "tcp_peer_addr"
        } else {
            "tcp_local_addr"
        };
        assert_eq!(self.call(operation, id), ADDRESS_SIZE as i32);
        decode_address(&self.buffer()[..ADDRESS_SIZE]).unwrap()
    }
}
fn read_exact(guest: &mut Guest, id: u32, expected: &[u8]) {
    let mut received = Vec::new();
    while received.len() < expected.len() {
        let count = wait(|| guest.io("tcp_read", id, (expected.len() - received.len()) as u32));
        assert!(count > 0);
        received.extend_from_slice(&guest.buffer()[..count as usize]);
    }
    assert_eq!(received, expected);
}
impl Drop for Guest {
    fn drop(&mut self) {
        self.zero("tcp_dispose");
    }
}
fn wait(mut call: impl FnMut() -> i32) -> i32 {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let result = call();
        if result != -1 {
            return result;
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(1));
    }
}
#[test]
fn compiled_module_binds_dual_stack_and_round_trips_real_bytes() {
    let mut guest = Guest::new();
    let listener = guest.call("tcp_listen_default", 0);
    assert!(listener > 0);
    let address = guest.address(listener as u32, false);
    let mut client =
        TcpStream::connect(SocketAddr::new(Ipv4Addr::LOCALHOST.into(), address.port())).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let accepted = wait(|| guest.call("tcp_accept", listener as u32));
    assert!(accepted > 0);
    let accepted = accepted as u32;
    let accepted_local = guest.address(accepted, false);
    let accepted_peer = guest.address(accepted, true);
    assert_eq!(accepted_local.port(), client.peer_addr().unwrap().port());
    assert_eq!(accepted_peer.port(), client.local_addr().unwrap().port());
    assert!(!accepted_local.ip().is_unspecified());
    assert!(!accepted_peer.ip().is_unspecified());
    assert_eq!(guest.io("tcp_read", accepted, 4), -1);
    client.write_all(b"ping").unwrap();
    read_exact(&mut guest, accepted, b"ping");
    guest.buffer()[..4].copy_from_slice(b"pong");
    assert_eq!(guest.io("tcp_write", accepted, 4), 4);
    assert_eq!(guest.call("tcp_shutdown", accepted), 0);
    let mut bytes = Vec::new();
    client.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, b"pong");
    assert_eq!(guest.io("tcp_write", accepted, 1), -6);
    assert_eq!(guest.io("tcp_read", accepted, BUFFER_SIZE as u32 + 1), -2);
    assert_eq!(guest.call("tcp_close", accepted), 0);
    assert_eq!(guest.io("tcp_write", accepted, 1), -2);
    assert_eq!(guest.call("tcp_close", listener as u32), 0);
}
#[test]
fn compiled_module_dials_and_disposes_its_resources() {
    let mut guest = Guest::new();
    let listener = guest.call("tcp_listen_default", 0) as u32;
    let local = guest.address(listener, false);
    let address = SocketAddr::new(Ipv4Addr::LOCALHOST.into(), local.port());
    guest.buffer()[..ADDRESS_SIZE].copy_from_slice(&encode_address(address));
    let client = guest.zero("tcp_connect") as u32;
    let server = wait(|| guest.call("tcp_accept", listener)) as u32;
    guest.buffer()[..4].copy_from_slice(b"ping");
    assert_eq!(wait(|| guest.io("tcp_write", client, 4)), 4);
    guest.call("tcp_poll", client);
    read_exact(&mut guest, server, b"ping");
    assert_eq!(guest.zero("tcp_dispose"), 0);
    assert_eq!(guest.call("tcp_accept", listener), -2);
    // Dispose does not reuse old IDs when this module starts serving again.
    let new_listener = guest.call("tcp_listen_default", 0) as u32;
    assert!(new_listener > client && new_listener > server);
}

#[cfg(unix)]
#[test]
fn host_readiness_drives_accept_connect_and_data_without_sleep_polling() {
    let mut guest = Guest::new();
    let listener = guest.call("tcp_listen_default", 0) as u32;
    let address = SocketAddr::new(
        Ipv4Addr::LOCALHOST.into(),
        guest.address(listener, false).port(),
    );
    guest.buffer()[..ADDRESS_SIZE].copy_from_slice(&encode_address(address));
    let client = guest.zero("tcp_connect") as u32;
    let client_interests = guest.call("tcp_interests", client) as u32;
    let listener_interests = guest.call("tcp_interests", listener) as u32;
    assert_ne!(
        guest
            .store
            .data()
            .wait_ready(client, client_interests, Duration::from_secs(3))
            .unwrap()
            & 2,
        0
    );
    assert_ne!(
        guest
            .store
            .data()
            .wait_ready(listener, listener_interests, Duration::from_secs(3))
            .unwrap()
            & 1,
        0
    );
    let server = guest.call("tcp_accept", listener) as u32;
    guest.buffer()[..4].copy_from_slice(b"wake");
    assert_eq!(guest.io("tcp_write", client, 4), 4);
    guest.call("tcp_poll", client);
    assert_eq!(guest.call("tcp_interests", client), 1);
    let server_interests = guest.call("tcp_interests", server) as u32;
    assert_ne!(
        guest
            .store
            .data()
            .wait_ready(server, server_interests, Duration::from_secs(3))
            .unwrap()
            & 1,
        0
    );
    assert_eq!(guest.call("tcp_poll", server), 0);
    let mut output = Vec::new();
    while output.len() < 4 {
        let n = guest.io("tcp_read", server, 4 - output.len() as u32);
        assert!(n > 0);
        output.extend_from_slice(&guest.buffer()[..n as usize]);
    }
    assert_eq!(output, b"wake");
    assert_eq!(guest.call("tcp_shutdown", client), 0);
    assert_ne!(
        guest
            .store
            .data()
            .wait_ready(server, 1, Duration::from_secs(3))
            .unwrap(),
        0
    );
    assert_eq!(guest.call("tcp_poll", server), 0);
    assert_eq!(guest.io("tcp_read", server, 1), 0);
    assert_eq!(guest.call("tcp_interests", server), 0);
    assert_eq!(guest.call("tcp_close", client), 0);
    assert!(
        guest
            .store
            .data()
            .wait_ready(client, 1, Duration::ZERO)
            .is_err()
    );
}

#[cfg(target_os = "linux")]
#[test]
fn compiled_module_ipv4_fallback_without_ipv6() {
    use std::os::unix::process::CommandExt;
    if std::env::var_os("WAFFLE_MODULE_NO_IPV6").is_some() {
        assert_eq!(
            std::net::TcpListener::bind(("::", 0))
                .unwrap_err()
                .raw_os_error(),
            Some(libc::EAFNOSUPPORT)
        );
        compiled_module_binds_dual_stack_and_round_trips_real_bytes();
        return;
    }
    let mut child = std::process::Command::new(std::env::current_exe().unwrap());
    child
        .args(["--exact", "compiled_module_ipv4_fallback_without_ipv6"])
        .env("WAFFLE_MODULE_NO_IPV6", "1");
    unsafe {
        child.pre_exec(support::deny_ipv6_socket);
    }
    assert!(child.status().unwrap().success());
}

#[cfg(unix)]
#[test]
fn graceful_close_drains_admitted_output_and_unread_input_before_eof() {
    let mut guest = Guest::new();
    let listener = guest.call("tcp_listen_default", 0) as u32;
    let address = SocketAddr::new(
        Ipv4Addr::LOCALHOST.into(),
        guest.address(listener, false).port(),
    );
    let mut peer = TcpStream::connect(address).unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    peer.write_all(&[9; 128]).unwrap();
    peer.shutdown(std::net::Shutdown::Write).unwrap();
    assert_ne!(
        guest
            .store
            .data()
            .wait_ready(listener, 1, Duration::from_secs(3))
            .unwrap(),
        0
    );
    let server = guest.call("tcp_accept", listener) as u32;
    let response = b"response admitted only once";
    guest.buffer()[..response.len()].copy_from_slice(response);
    assert_eq!(
        guest.io("tcp_write", server, response.len() as u32),
        response.len() as i32
    );
    assert_eq!(guest.call("tcp_close_graceful", server), 0);
    let deadline = Instant::now() + Duration::from_secs(3);
    while guest.call("tcp_close_status", server) != 3 {
        assert!(Instant::now() < deadline);
        let interests = guest.call("tcp_interests", server) as u32;
        assert_ne!(
            guest
                .store
                .data()
                .wait_ready(
                    server,
                    interests,
                    deadline.saturating_duration_since(Instant::now())
                )
                .unwrap(),
            0
        );
        assert_eq!(guest.call("tcp_poll", server), 0);
    }
    assert_eq!(guest.call("tcp_close", server), 0);
    let mut received = Vec::new();
    peer.read_to_end(&mut received).unwrap();
    assert_eq!(received, response);
}

#[cfg(unix)]
fn accept_ready(guest: &mut Guest, listener: u32) -> u32 {
    assert_ne!(
        guest
            .store
            .data()
            .wait_ready(listener, 1, Duration::from_secs(3))
            .unwrap(),
        0
    );
    let accepted = guest.call("tcp_accept", listener);
    assert!(accepted > 0);
    accepted as u32
}

#[cfg(unix)]
#[test]
fn wait_many_does_not_hide_ready_connection_behind_idle_connection() {
    use waffle_tcp::native::Readiness;
    let mut guest = Guest::new();
    let listener = guest.call("tcp_listen_default", 0) as u32;
    let address = SocketAddr::new(
        Ipv4Addr::LOCALHOST.into(),
        guest.address(listener, false).port(),
    );
    let _idle_peer = TcpStream::connect(address).unwrap();
    let idle = accept_ready(&mut guest, listener);
    let mut ready_peer = TcpStream::connect(address).unwrap();
    let active = accept_ready(&mut guest, listener);
    ready_peer.write_all(b"B").unwrap();
    let (mut control, _wake) = Readiness::new().unwrap();
    let ready = guest
        .store
        .data()
        .wait_many(
            &[(idle, 1), (active, 1)],
            &mut control,
            Some(Duration::from_secs(3)),
        )
        .unwrap();
    assert!(!ready.control);
    assert_eq!(ready.sockets, vec![(active, 1)]);
    assert_eq!(guest.call("tcp_poll", active), 0);
    assert_eq!(guest.io("tcp_read", active, 1), 1);
    assert_eq!(guest.buffer()[0], b'B');
    assert_eq!(guest.call("tcp_close", listener), 0);
    guest.buffer()[..ADDRESS_SIZE].copy_from_slice(&encode_address(SocketAddr::new(
        std::net::Ipv6Addr::UNSPECIFIED.into(),
        address.port(),
    )));
    let rebound = guest.zero("tcp_listen");
    assert!(
        rebound > 0,
        "accepted streams must not retain the listener port: {rebound}"
    );
    assert_eq!(guest.call("tcp_close", rebound as u32), 0);
    ready_peer.write_all(b"C").unwrap();
    assert_ne!(
        guest
            .store
            .data()
            .wait_ready(active, 1, Duration::from_secs(3))
            .unwrap(),
        0
    );
    assert_eq!(guest.io("tcp_read", active, 1), 1);
    assert_eq!(guest.buffer()[0], b'C');
}

#[cfg(unix)]
#[test]
fn listener_graceful_close_accepts_pending_peer_and_requires_eof_not_reset() {
    let mut guest = Guest::new();
    let listener = guest.call("tcp_listen_default", 0) as u32;
    let address = SocketAddr::new(
        Ipv4Addr::LOCALHOST.into(),
        guest.address(listener, false).port(),
    );
    let mut peer = TcpStream::connect(address).unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    peer.write_all(b"pending request").unwrap();
    peer.shutdown(std::net::Shutdown::Write).unwrap();
    assert_eq!(guest.call("tcp_close_graceful", listener), 0);
    assert_eq!(guest.call("tcp_accept", listener), -2);
    let draining = guest.call("tcp_next", 0) as u32;
    assert!(draining > listener);
    let deadline = Instant::now() + Duration::from_secs(3);
    while guest.call("tcp_close_status", draining) != 3 {
        assert!(Instant::now() < deadline);
        assert_ne!(
            guest
                .store
                .data()
                .wait_ready(
                    draining,
                    1,
                    deadline.saturating_duration_since(Instant::now())
                )
                .unwrap(),
            0
        );
        assert_eq!(guest.call("tcp_poll", draining), 0);
    }
    assert_eq!(guest.call("tcp_close", draining), 0);
    assert_eq!(guest.call("tcp_next", 0), 0);
    assert_eq!(peer.read(&mut [0]).unwrap(), 0);
}

#[cfg(unix)]
struct JoinedDriver {
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    wake: waffle_tcp::native::ControlWake,
    thread: Option<thread::JoinHandle<()>>,
}

#[cfg(unix)]
impl JoinedDriver {
    fn start(mut guest: Guest, target: u32) -> (Self, std::sync::mpsc::Receiver<u32>) {
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
            mpsc,
        };
        use waffle_tcp::native::Readiness;
        let (mut control, wake) = Readiness::new().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let (send, receive) = mpsc::channel();
        let thread = thread::spawn(move || {
            let mut last_status = 0;
            while !stopping.load(Ordering::SeqCst) {
                publish_close_status(&mut guest, target, &mut last_status, &send);
                let interests = module_interests(&mut guest);
                send.send(4).unwrap();
                let ready = guest
                    .store
                    .data()
                    .wait_many(&interests, &mut control, Some(Duration::from_secs(3)))
                    .unwrap();
                assert!(
                    ready.control || !ready.sockets.is_empty(),
                    "module actor readiness deadline expired"
                );
                poll_ready(&mut guest, ready.sockets);
            }
            assert_eq!(guest.zero("tcp_dispose"), 0);
            assert_eq!(guest.call("tcp_next", 0), 0);
        });
        (
            Self {
                stop,
                wake,
                thread: Some(thread),
            },
            receive,
        )
    }

    fn join(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        self.wake.wake().unwrap();
        self.thread.take().unwrap().join().unwrap();
    }
}

#[cfg(unix)]
impl Drop for JoinedDriver {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        let _ = self.wake.wake();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(unix)]
fn publish_close_status(
    guest: &mut Guest,
    target: u32,
    last: &mut u32,
    send: &std::sync::mpsc::Sender<u32>,
) {
    if *last == 3 {
        return;
    }
    let status = guest.call("tcp_close_status", target);
    assert!(status >= 0);
    if status as u32 == *last {
        return;
    }
    *last = status as u32;
    send.send(*last).unwrap();
    if *last == 3 {
        assert_eq!(guest.call("tcp_close", target), 0);
    }
}

#[cfg(unix)]
fn module_interests(guest: &mut Guest) -> Vec<(u32, u32)> {
    let mut interests = Vec::new();
    let mut id = guest.call("tcp_next", 0);
    while id > 0 {
        let bits = guest.call("tcp_interests", id as u32);
        assert!((0..4).contains(&bits));
        interests.push((id as u32, bits as u32));
        id = guest.call("tcp_next", id as u32);
    }
    assert_eq!(id, 0);
    interests
}

#[cfg(unix)]
fn receive_status(events: &std::sync::mpsc::Receiver<u32>, expected: u32) {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let event = events
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap();
        if event == expected {
            return;
        }
    }
}

#[cfg(unix)]
#[test]
fn actor_drains_without_repeat_write_reports_flushed_then_joins_on_control_wake() {
    let mut guest = Guest::new();
    let listener = guest.call("tcp_listen_default", 0) as u32;
    let address = SocketAddr::new(
        Ipv4Addr::LOCALHOST.into(),
        guest.address(listener, false).port(),
    );
    let mut idle_peer = TcpStream::connect(address).unwrap();
    idle_peer
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    accept_ready(&mut guest, listener);
    let mut peer = TcpStream::connect(address).unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    let active = accept_ready(&mut guest, listener);
    assert_eq!(guest.call("tcp_close", listener), 0);
    peer.write_all(&[7; 256]).unwrap();
    let response = b"one admitted response, many readiness turns";
    guest.buffer()[..response.len()].copy_from_slice(response);
    assert_eq!(
        guest.io("tcp_write", active, response.len() as u32),
        response.len() as i32
    );
    assert_eq!(guest.call("tcp_close_graceful", active), 0);
    assert_eq!(guest.call("tcp_close_status", active), 0);
    let (mut driver, events) = JoinedDriver::start(guest, active);
    receive_status(&events, 1);
    let mut bytes = Vec::new();
    peer.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, response);
    peer.shutdown(std::net::Shutdown::Write).unwrap();
    receive_status(&events, 3);
    receive_status(&events, 4);
    let before_cancel = Instant::now();
    driver.join();
    assert!(
        before_cancel.elapsed() < Duration::from_secs(2),
        "control wake must interrupt the three-second OS wait"
    );
    assert_eq!(idle_peer.read(&mut [0]).unwrap(), 0);
    let mut fresh = Guest::new();
    fresh.buffer()[..ADDRESS_SIZE].copy_from_slice(&encode_address(SocketAddr::new(
        std::net::Ipv6Addr::UNSPECIFIED.into(),
        address.port(),
    )));
    assert!(fresh.zero("tcp_listen") > 0);
}

#[test]
fn compiled_module_preserves_transport_reachability_classes() {
    for code in [-14, -15, -16] {
        let mut guest = Guest::with_error(Some((CONNECT, code)));
        guest.buffer()[..ADDRESS_SIZE]
            .copy_from_slice(&encode_address("127.0.0.1:1".parse().unwrap()));
        assert_eq!(guest.zero("tcp_connect"), code);
        assert_eq!(guest.call("tcp_next", 0), 0);
    }
}

#[cfg(unix)]
fn poll_ready(guest: &mut Guest, ready: Vec<(u32, u32)>) {
    for (id, _) in ready {
        assert_eq!(guest.call("tcp_poll", id), 0);
    }
}
