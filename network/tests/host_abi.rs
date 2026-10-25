use std::net::SocketAddr;
use waffle_tcp::{SocketHost, abi::*, native::NativeHost};

#[test]
fn host_address_commands_reject_short_lengths_before_binding() {
    let mut host = NativeHost::default();
    let socket = host.open(false).unwrap();
    let address: SocketAddr = "127.0.0.1:0".parse().unwrap();
    let mut memory = encode_address(address);
    assert_eq!(host.dispatch(BIND, socket, 0, 31, &mut memory), -2);
    assert_eq!(host.dispatch(BIND, socket, 0, 32, &mut memory), 0);
    host.close(socket);
}

#[test]
fn host_span_bounds_do_not_modify_memory_or_issue_socket_operations() {
    let mut host = NativeHost::default();
    let socket = host.open(false).unwrap();
    let mut memory = [91; 64];
    for operation in [READ, WRITE, BIND, CONNECT, LOCAL_ADDR, PEER_ADDR] {
        for (pointer, length) in [(u32::MAX, 32), (63, 32), (32, u32::MAX)] {
            assert_eq!(
                host.dispatch(operation, socket, pointer, length, &mut memory),
                -2
            );
            assert_eq!(memory, [91; 64]);
        }
    }
    host.close(socket);
    assert_eq!(host.dispatch(READ, socket, 0, 0, &mut memory), -2);
}
