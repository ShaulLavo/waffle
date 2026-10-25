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
                |mut caller: Caller<'_, NativeHost>, op: u32, id: u32, ptr: u32, len: u32| {
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
