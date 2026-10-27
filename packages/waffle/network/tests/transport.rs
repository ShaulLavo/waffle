mod support;
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddr, TcpStream};
use std::thread;
use std::time::{Duration, Instant};
use waffle_tcp::{Tcp, native::NativeHost};

fn wait<T>(mut operation: impl FnMut() -> io::Result<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match operation() {
            Ok(value) => return value,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
            Err(error) => panic!("{error}"),
        }
        assert!(Instant::now() < deadline, "transport did not become ready");
        thread::sleep(Duration::from_millis(1));
    }
}

fn write_all(tcp: &mut Tcp<NativeHost>, id: waffle_tcp::SocketId, bytes: &[u8]) {
    let mut at = 0;
    while at < bytes.len() {
        let count = wait(|| tcp.write(id, &bytes[at..]));
        assert!(count > 0 && count <= bytes.len() - at);
        at += count;
    }
}
fn read_exact(tcp: &mut Tcp<NativeHost>, id: waffle_tcp::SocketId, bytes: &mut [u8]) {
    let mut at = 0;
    while at < bytes.len() {
        let count = wait(|| tcp.read(id, &mut bytes[at..]));
        assert!(count > 0 && count <= bytes.len() - at);
        at += count;
    }
}

#[test]
fn unspecified_listener_accepts_ipv4() {
    let mut tcp = Tcp::new(NativeHost::default());
    let listener = tcp.listen_default(0).unwrap();
    let address = SocketAddr::new(
        Ipv4Addr::LOCALHOST.into(),
        tcp.local_addr(listener).unwrap().port(),
    );
    let mut client = TcpStream::connect_timeout(&address, Duration::from_secs(2)).unwrap();
    client.write_all(b"pending request").unwrap();
    client.shutdown(Shutdown::Write).unwrap();
    let conn = wait(|| tcp.accept(listener));
    let mut bytes = [0; 32];
    read_exact(&mut tcp, conn, &mut bytes[..15]);
    assert_eq!(&bytes[..15], b"pending request");
    assert_eq!(wait(|| tcp.read(conn, &mut bytes)), 0);
    write_all(&mut tcp, conn, b"reply");
    tcp.shutdown(conn).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut response = Vec::new();
    client.read_to_end(&mut response).unwrap();
    assert_eq!(response, b"reply");
}

#[test]
fn native_client_uses_nonblocking_io_and_typed_addresses() {
    let mut tcp = Tcp::new(NativeHost::default());
    let listener = tcp.listen("127.0.0.1:0".parse().unwrap()).unwrap();
    let address = tcp.local_addr(listener).unwrap();
    let client = tcp.connect(address).unwrap();
    write_all(&mut tcp, client, b"ping");
    let server = wait(|| tcp.accept(listener));
    let mut bytes = [0; 4];
    read_exact(&mut tcp, server, &mut bytes);
    assert_eq!(&bytes, b"ping");
    assert_eq!(
        tcp.local_addr(client).unwrap(),
        tcp.peer_addr(server).unwrap()
    );
    assert_eq!(
        tcp.peer_addr(client).unwrap(),
        tcp.local_addr(server).unwrap()
    );
    assert_eq!(
        tcp.read(server, &mut bytes).unwrap_err().kind(),
        io::ErrorKind::WouldBlock
    );
    tcp.shutdown(server).unwrap();
    assert_eq!(wait(|| tcp.read(client, &mut bytes)), 0);
    assert_eq!(
        tcp.write(server, b"closed").unwrap_err().kind(),
        io::ErrorKind::BrokenPipe
    );
    write_all(&mut tcp, client, b"pong");
    read_exact(&mut tcp, server, &mut bytes);
}

#[test]
fn close_releases_port_but_keeps_accepted_streams_alive() {
    let mut tcp = Tcp::new(NativeHost::default());
    let listener = tcp.listen("127.0.0.1:0".parse().unwrap()).unwrap();
    let address = tcp.local_addr(listener).unwrap();
    let client = tcp.connect(address).unwrap();
    let server = wait(|| tcp.accept(listener));
    tcp.close(listener).unwrap();
    write_all(&mut tcp, client, b"live");
    let mut bytes = [0; 4];
    read_exact(&mut tcp, server, &mut bytes);
    tcp.close(client).unwrap();
    tcp.close(server).unwrap();
    let rebound = tcp.listen(address).unwrap();
    tcp.close(rebound).unwrap();
    assert!(tcp.accept(listener).is_err());
}

#[test]
fn dropping_transport_releases_listener_even_without_explicit_close() {
    let address = {
        let mut tcp = Tcp::new(NativeHost::default());
        let listener = tcp.listen("127.0.0.1:0".parse().unwrap()).unwrap();
        tcp.local_addr(listener).unwrap()
    };
    let mut tcp = Tcp::new(NativeHost::default());
    tcp.listen(address).unwrap();
}

#[cfg(target_os = "linux")]
#[test]
fn unspecified_listener_falls_back_without_ipv6() {
    use std::os::unix::process::CommandExt;
    if std::env::var_os("WAFFLE_TEST_NO_IPV6").is_some() {
        assert_eq!(
            std::net::TcpListener::bind(("::", 0))
                .unwrap_err()
                .raw_os_error(),
            Some(libc::EAFNOSUPPORT)
        );
        unspecified_listener_accepts_ipv4();
        return;
    }
    let mut child = std::process::Command::new(std::env::current_exe().unwrap());
    child
        .args(["--exact", "unspecified_listener_falls_back_without_ipv6"])
        .env("WAFFLE_TEST_NO_IPV6", "1");
    unsafe {
        child.pre_exec(support::deny_ipv6_socket);
    }
    assert!(child.status().unwrap().success());
}

#[test]
fn real_ipv6_loopback_when_available() {
    let probe = match std::net::TcpListener::bind(("::1", 0)) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("SKIP IPv6 loopback unavailable: {error}");
            return;
        }
    };
    drop(probe);
    let mut tcp = Tcp::new(NativeHost::default());
    let listener = tcp.listen_default(0).unwrap();
    assert!(tcp.local_addr(listener).unwrap().is_ipv6());
    let mut client = TcpStream::connect(("::1", tcp.local_addr(listener).unwrap().port())).unwrap();
    client.write_all(b"ipv6").unwrap();
    let server = wait(|| tcp.accept(listener));
    assert!(tcp.local_addr(server).unwrap().is_ipv6());
    assert!(tcp.peer_addr(server).unwrap().ip().is_loopback());
    let mut bytes = [0; 4];
    read_exact(&mut tcp, server, &mut bytes);
    assert_eq!(&bytes, b"ipv6");
    eprintln!("IPv6 loopback exercised");
}

#[test]
fn listener_close_terminates_unaccepted_peer_with_eof_or_reset() {
    let mut tcp = Tcp::new(NativeHost::default());
    let listener = tcp.listen("127.0.0.1:0".parse().unwrap()).unwrap();
    let address = tcp.local_addr(listener).unwrap();
    let mut client = TcpStream::connect(address).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    tcp.close(listener).unwrap();
    let ended = client.read(&mut [0]);
    assert!(
        matches!(ended, Ok(0))
            || ended.is_err_and(|error| matches!(
                error.kind(),
                io::ErrorKind::ConnectionReset | io::ErrorKind::ConnectionAborted
            ))
    );
    tcp.listen(address).unwrap();
}

#[test]
fn ipv6_only_os_default_is_overridden_for_unspecified_listener() {
    let control = socket2::Socket::new(
        socket2::Domain::IPV6,
        socket2::Type::STREAM,
        Some(socket2::Protocol::TCP),
    );
    let Ok(control) = control else {
        eprintln!("SKIP IPv6-only control: IPv6 unavailable");
        return;
    };
    control.set_only_v6(true).unwrap();
    control
        .bind(&"[::]:0".parse::<SocketAddr>().unwrap().into())
        .unwrap();
    control.listen(8).unwrap();
    let port = control.local_addr().unwrap().as_socket().unwrap().port();
    assert!(
        TcpStream::connect_timeout(
            &SocketAddr::new(Ipv4Addr::LOCALHOST.into(), port),
            Duration::from_secs(1)
        )
        .is_err()
    );
    unspecified_listener_accepts_ipv4();
}
