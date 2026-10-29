use std::io::ErrorKind;
use std::net::SocketAddr;
use waffle_tcp::virtual_net::VirtualNet;

fn addr(value: &str) -> SocketAddr {
    value.parse().unwrap()
}

#[test]
fn virtual_dual_stack_metadata_conflicts_and_external_denial() {
    let mut net = VirtualNet::default();
    let port = net.listen(addr("[::]:0")).unwrap();
    assert_eq!(port, 49152);
    assert_eq!(
        net.listen(addr("127.0.0.1:49152")).unwrap_err().kind(),
        ErrorKind::AddrInUse
    );
    assert_eq!(
        net.listen(addr("192.0.2.1:0")).unwrap_err().kind(),
        ErrorKind::Unsupported
    );
    let client = net.connect(addr("127.0.0.1:49152")).unwrap();
    let server = net.peer(client).unwrap();
    assert_eq!(
        net.local_addr(server).unwrap(),
        addr("[::ffff:127.0.0.1]:49152")
    );
    assert_eq!(net.peer_addr(client).unwrap(), addr("127.0.0.1:49152"));
    assert_eq!(
        net.connect(addr("192.0.2.1:49152")).unwrap_err().kind(),
        ErrorKind::Unsupported
    );
    net.unlisten(port);
    assert_eq!(net.write(server, b"alive").unwrap(), 5);
    let mut out = [0; 5];
    assert_eq!(net.take(client, &mut out).unwrap(), 5);
    assert_eq!(&out, b"alive");
}

#[test]
fn queue_copy_partial_credit_half_close_and_stale_events() {
    let mut net = VirtualNet::default();
    let port = net.listen(addr("127.0.0.1:0")).unwrap();
    let client = net.connect(addr("127.0.0.1:49152")).unwrap();
    let server = net.peer(client).unwrap();
    let mut bytes = vec![7; (1 << 20) + 9];
    assert_eq!(net.write(client, &bytes).unwrap(), 1 << 20);
    bytes.fill(9);
    assert_eq!(
        net.write(client, b"x").unwrap_err().kind(),
        ErrorKind::WouldBlock
    );
    let mut out = [0; 65536];
    assert_eq!(net.take(server, &mut out).unwrap(), 65536);
    assert!(out.iter().all(|byte| *byte == 7));
    // Copying to a ring does not release credit until the guest consumes it.
    assert_eq!(
        net.write(client, b"x").unwrap_err().kind(),
        ErrorKind::WouldBlock
    );
    assert!(net.consumed(server, 65536));
    assert_eq!(net.write(client, b"tail").unwrap(), 4);
    net.shutdown(client).unwrap();
    assert!(net.ended(server));
    assert_eq!(
        net.write(client, b"late").unwrap_err().kind(),
        ErrorKind::BrokenPipe
    );
    net.close(client);
    net.close(server);
    assert!(!net.consumed(server, 1));
    assert_eq!(
        net.write(server, b"late").unwrap_err().kind(),
        ErrorKind::InvalidInput
    );
    net.unlisten(port);
    assert_eq!(net.listen(addr("127.0.0.1:49153")).unwrap(), 49153);
}

#[test]
fn addressless_pair_reuses_credit_half_close_and_touches_no_port() {
    let mut net = VirtualNet::default();
    let client = net.pair().unwrap();
    let server = net.peer(client).unwrap();
    assert_eq!(net.peer(server).unwrap(), client);
    assert_eq!(
        net.local_addr(client).unwrap_err().kind(),
        ErrorKind::Unsupported
    );
    assert_eq!(
        net.peer_addr(server).unwrap_err().kind(),
        ErrorKind::Unsupported
    );
    // A pair takes no ephemeral port, so the first dynamic listener still gets the first port.
    assert_eq!(net.listen(addr("127.0.0.1:0")).unwrap(), 49152);
    let bytes = vec![3; (1 << 20) + 1];
    assert_eq!(net.write(client, &bytes).unwrap(), 1 << 20);
    assert_eq!(
        net.write(client, b"x").unwrap_err().kind(),
        ErrorKind::WouldBlock
    );
    let mut out = [0; 4];
    assert_eq!(net.take(server, &mut out).unwrap(), 4);
    assert!(net.consumed(server, 4));
    assert_eq!(net.write(client, b"tail").unwrap(), 4);
    net.shutdown(server).unwrap();
    assert!(net.ended(client));
    assert!(!net.ended(server));
    net.close(client);
    assert_eq!(
        net.write(server, b"late").unwrap_err().kind(),
        ErrorKind::BrokenPipe
    );
    net.close(server);
    assert_eq!(net.listen(addr("127.0.0.1:0")).unwrap(), 49153);
}
