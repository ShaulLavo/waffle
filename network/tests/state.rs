use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::io::{self, ErrorKind};
use std::net::SocketAddr;
use std::rc::Rc;
use waffle_tcp::{SocketHost, Tcp};

#[derive(Default)]
struct Host {
    next: u32,
    fail_v6: bool,
    attempts: Rc<RefCell<Vec<bool>>>,
    bind_error: Option<ErrorKind>,
    sent: Rc<RefCell<Vec<u8>>>,
    incoming: VecDeque<u8>,
    blocked: Rc<Cell<bool>>,
    refusal: bool,
    eof: bool,
    shutdown_error: Option<ErrorKind>,
    shutdowns: Rc<Cell<u32>>,
}
impl SocketHost for Host {
    fn open(&mut self, v6: bool) -> io::Result<u32> {
        self.attempts.borrow_mut().push(v6);
        if v6 && self.fail_v6 {
            return Err(ErrorKind::Unsupported.into());
        }
        self.next += 1;
        Ok(self.next)
    }
    fn dual_stack(&mut self, _: u32) -> io::Result<()> {
        Ok(())
    }
    fn bind(&mut self, _: u32, _: SocketAddr) -> io::Result<()> {
        match self.bind_error {
            Some(kind) => Err(kind.into()),
            None => Ok(()),
        }
    }
    fn listen(&mut self, _: u32) -> io::Result<()> {
        Ok(())
    }
    fn connect(&mut self, _: u32, _: SocketAddr) -> io::Result<()> {
        Err(ErrorKind::WouldBlock.into())
    }
    fn connected(&mut self, _: u32) -> io::Result<()> {
        if self.refusal {
            self.refusal = false;
            return Err(ErrorKind::ConnectionRefused.into());
        }
        Ok(())
    }
    fn accept(&mut self, _: u32) -> io::Result<u32> {
        self.next += 1;
        Ok(self.next)
    }
    fn read(&mut self, _: u32, out: &mut [u8]) -> io::Result<usize> {
        if self.incoming.is_empty() {
            return if self.eof {
                Ok(0)
            } else {
                Err(ErrorKind::WouldBlock.into())
            };
        }
        let count = out.len().min(self.incoming.len());
        for byte in &mut out[..count] {
            *byte = self.incoming.pop_front().unwrap();
        }
        Ok(count)
    }
    fn write(&mut self, _: u32, bytes: &[u8]) -> io::Result<usize> {
        if self.blocked.get() {
            return Err(ErrorKind::WouldBlock.into());
        }
        let count = bytes.len().min(3);
        self.sent.borrow_mut().extend(&bytes[..count]);
        Ok(count)
    }
    fn shutdown(&mut self, _: u32) -> io::Result<()> {
        self.shutdowns.set(self.shutdowns.get() + 1);
        self.shutdown_error.map_or(Ok(()), |kind| Err(kind.into()))
    }
    fn local_addr(&mut self, _: u32) -> io::Result<SocketAddr> {
        Ok("127.0.0.1:4000".parse().unwrap())
    }
    fn peer_addr(&mut self, _: u32) -> io::Result<SocketAddr> {
        Ok("127.0.0.1:5000".parse().unwrap())
    }
    fn close(&mut self, _: u32) {}
}
#[test]
fn failed_connect_remains_failed_after_host_error_is_consumed() {
    let mut tcp = Tcp::new(Host {
        refusal: true,
        ..Host::default()
    });
    let id = tcp.connect("127.0.0.1:1".parse().unwrap()).unwrap();
    assert_eq!(
        tcp.write(id, b"x").unwrap_err().kind(),
        ErrorKind::ConnectionRefused
    );
    assert_eq!(
        tcp.write(id, b"x").unwrap_err().kind(),
        ErrorKind::ConnectionRefused
    );
}
#[test]
fn pending_writes_are_bounded_and_partial_host_writes_keep_fifo_order() {
    let mut tcp = Tcp::new(Host {
        blocked: Rc::new(Cell::new(true)),
        ..Host::default()
    });
    let id = tcp.connect("127.0.0.1:1".parse().unwrap()).unwrap();
    assert_eq!(tcp.write(id, &vec![7; 1 << 20]).unwrap(), 1 << 20);
    assert_eq!(
        tcp.write(id, b"x").unwrap_err().kind(),
        ErrorKind::WouldBlock
    );
}
#[test]
fn unspecified_falls_back_but_explicit_ipv6_does_not() {
    let mut tcp = Tcp::new(Host {
        fail_v6: true,
        ..Host::default()
    });
    assert!(tcp.listen_default(0).is_ok());
    assert_eq!(
        tcp.listen("[::1]:0".parse().unwrap()).unwrap_err().kind(),
        ErrorKind::Unsupported
    );
}

#[test]
fn short_writes_advance_offsets_and_readiness_drains_pending_bytes() {
    let blocked = Rc::new(Cell::new(true));
    let sent = Rc::new(RefCell::new(Vec::new()));
    let host = Host {
        blocked: blocked.clone(),
        sent: sent.clone(),
        ..Host::default()
    };
    let mut tcp = Tcp::new(host);
    let id = tcp.connect("127.0.0.1:1".parse().unwrap()).unwrap();
    assert_eq!(tcp.write(id, b"partial-byte-stream").unwrap(), 19);
    assert!(sent.borrow().is_empty());
    blocked.set(false);
    for _ in 0..10 {
        tcp.poll(id).unwrap();
    }
    assert_eq!(sent.borrow().as_slice(), b"partial-byte-stream");
}

#[test]
fn bind_policy_falls_back_only_for_ipv6_unavailability() {
    for kind in [
        ErrorKind::AddrInUse,
        ErrorKind::PermissionDenied,
        ErrorKind::Other,
    ] {
        let attempts = Rc::new(RefCell::new(Vec::new()));
        let mut tcp = Tcp::new(Host {
            attempts: attempts.clone(),
            bind_error: Some(kind),
            ..Host::default()
        });
        assert_eq!(tcp.listen_default(8080).unwrap_err().kind(), kind);
        assert_eq!(attempts.borrow().as_slice(), &[true]);
    }
    let attempts = Rc::new(RefCell::new(Vec::new()));
    let mut tcp = Tcp::new(Host {
        attempts: attempts.clone(),
        fail_v6: true,
        ..Host::default()
    });
    tcp.listen_default(0).unwrap();
    assert_eq!(attempts.borrow().as_slice(), &[true, false]);
}

#[test]
fn readiness_interests_follow_connect_queue_backpressure_and_shutdown() {
    let blocked = Rc::new(Cell::new(true));
    let mut tcp = Tcp::new(Host {
        blocked: blocked.clone(),
        ..Host::default()
    });
    let listener = tcp.listen_default(0).unwrap();
    assert_eq!(tcp.interests(listener).unwrap(), 1);
    let id = tcp.connect("127.0.0.1:1".parse().unwrap()).unwrap();
    assert_eq!(tcp.interests(id).unwrap(), 2);
    tcp.write(id, b"queued").unwrap();
    assert_eq!(tcp.interests(id).unwrap(), 3);
    tcp.shutdown(id).unwrap();
    assert_eq!(tcp.interests(id).unwrap(), 3);
    blocked.set(false);
    tcp.poll(id).unwrap();
    assert_eq!(tcp.interests(id).unwrap(), 3);
    tcp.poll(id).unwrap();
    assert_eq!(tcp.interests(id).unwrap(), 1);
    tcp.close(id).unwrap();
    assert_eq!(
        tcp.interests(id).unwrap_err().kind(),
        ErrorKind::InvalidInput
    );
}

#[test]
fn graceful_discard_ignores_full_receive_queue_without_guest_reads() {
    let shutdowns = Rc::new(Cell::new(0));
    let mut tcp = Tcp::new(Host {
        incoming: vec![9; 2 << 20].into(),
        eof: true,
        shutdowns: shutdowns.clone(),
        ..Host::default()
    });
    let listener = tcp.listen_default(0).unwrap();
    let stream = tcp.accept(listener).unwrap();
    for _ in 0..16 {
        tcp.poll(stream).unwrap();
    }
    assert_eq!(tcp.interests(stream).unwrap(), 0);
    tcp.close_graceful(stream).unwrap();
    assert_eq!(tcp.close_status(stream).unwrap(), 1);
    assert_eq!(tcp.interests(stream).unwrap(), 1);
    for _ in 0..16 {
        tcp.poll(stream).unwrap();
    }
    assert_eq!(tcp.close_status(stream).unwrap(), 3);
    assert_eq!(tcp.interests(stream).unwrap(), 0);
    assert_eq!(tcp.read(stream, &mut [0; 1]).unwrap(), 0);
    tcp.close_graceful(stream).unwrap();
    tcp.shutdown(stream).unwrap();
    assert_eq!(shutdowns.get(), 1);
}

#[test]
fn graceful_shutdown_failure_stays_terminal_and_is_not_reissued() {
    let shutdowns = Rc::new(Cell::new(0));
    let mut tcp = Tcp::new(Host {
        shutdown_error: Some(ErrorKind::BrokenPipe),
        shutdowns: shutdowns.clone(),
        ..Host::default()
    });
    let listener = tcp.listen_default(0).unwrap();
    let stream = tcp.accept(listener).unwrap();
    assert_eq!(
        tcp.close_graceful(stream).unwrap_err().kind(),
        ErrorKind::BrokenPipe
    );
    assert_eq!(
        tcp.close_status(stream).unwrap_err().kind(),
        ErrorKind::BrokenPipe
    );
    assert_eq!(tcp.interests(stream).unwrap(), 4);
    assert_eq!(tcp.poll(stream).unwrap_err().kind(), ErrorKind::BrokenPipe);
    assert_eq!(shutdowns.get(), 1);
    tcp.close(stream).unwrap();
    assert!(tcp.poll(stream).is_err());
}
