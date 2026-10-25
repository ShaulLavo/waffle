use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddr, TcpStream};
use std::task::Waker;
use std::thread;
use std::time::{Duration, Instant};
use waffle_tcp::{Connection, Listener};

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

#[test]
fn unspecified_listener_accepts_ipv4() {
    let listener = Listener::bind("::", 0, Waker::noop().clone()).unwrap();
    let address = SocketAddr::new(Ipv4Addr::LOCALHOST.into(), listener.local_addr().port());
    let mut client = TcpStream::connect_timeout(&address, Duration::from_secs(2)).unwrap();
    client.write_all(b"pending request").unwrap();
    client.shutdown(Shutdown::Write).unwrap();
    let conn = wait(|| listener.accept());
    let mut bytes = [0; 32];
    let n = wait(|| conn.read(&mut bytes));
    assert_eq!(&bytes[..n], b"pending request");
    assert_eq!(wait(|| conn.read(&mut bytes)), 0);
    wait(|| conn.write(b"reply"));
    conn.shutdown();
    client
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut response = Vec::new();
    client.read_to_end(&mut response).unwrap();
    assert_eq!(response, b"reply");
}

#[test]
fn native_client_uses_nonblocking_io_and_typed_addresses() {
    let listener = Listener::bind("127.0.0.1", 0, Waker::noop().clone()).unwrap();
    let client = Connection::connect(
        "127.0.0.1".into(),
        listener.local_addr().port(),
        Waker::noop().clone(),
    )
    .unwrap();
    wait(|| client.write(b"ping"));
    let server = wait(|| listener.accept());
    let mut bytes = [0; 4];
    assert_eq!(wait(|| server.read(&mut bytes)), 4);
    assert_eq!(&bytes, b"ping");
    assert_eq!(client.local_addr(), server.peer_addr());
    assert_eq!(client.peer_addr(), server.local_addr());
    assert_eq!(
        server.read(&mut bytes).unwrap_err().kind(),
        io::ErrorKind::WouldBlock
    );
}

#[test]
fn listener_drop_releases_port_and_pending_connections() {
    let listener = Listener::bind("127.0.0.1", 0, Waker::noop().clone()).unwrap();
    let address = listener.local_addr();
    let mut client = TcpStream::connect(address).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    client.write_all(b"unaccepted").unwrap();
    client.shutdown(Shutdown::Write).unwrap();
    drop(listener);
    assert_eq!(client.read(&mut [0; 1]).unwrap(), 0);
    let rebound = Listener::bind("127.0.0.1", address.port(), Waker::noop().clone()).unwrap();
    drop(rebound);
}

#[cfg(target_os = "linux")]
fn deny_ipv6_socket() -> io::Result<()> {
    let mut filter = [
        libc::sock_filter {
            code: 0x20,
            jt: 0,
            jf: 0,
            k: 0,
        },
        libc::sock_filter {
            code: 0x15,
            jt: 0,
            jf: 3,
            k: libc::SYS_socket as u32,
        },
        libc::sock_filter {
            code: 0x20,
            jt: 0,
            jf: 0,
            k: 16,
        },
        libc::sock_filter {
            code: 0x15,
            jt: 0,
            jf: 1,
            k: libc::AF_INET6 as u32,
        },
        libc::sock_filter {
            code: 0x06,
            jt: 0,
            jf: 0,
            k: 0x0005_0000 | libc::EAFNOSUPPORT as u32,
        },
        libc::sock_filter {
            code: 0x06,
            jt: 0,
            jf: 0,
            k: 0x7fff_0000,
        },
    ];
    let program = libc::sock_fprog {
        len: filter.len() as u16,
        filter: filter.as_mut_ptr(),
    };
    // Only the disposable child loses IPv6; host network settings never change.
    unsafe {
        if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
            return Err(io::Error::last_os_error());
        }
        if libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &program) != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
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
        child.pre_exec(deny_ipv6_socket);
    }
    assert!(child.status().unwrap().success());
}
