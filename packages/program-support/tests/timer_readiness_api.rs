use futures::{FutureExt, task::noop_waker};
use std::{
    future::Future,
    pin::Pin,
    task::Context,
    time::{Duration, Instant},
};
use waffle_program_support::{
    executor::{Executor, Sleep},
    io::Endpoint,
    runtime::poll_timeout,
};

#[test]
fn public_timer_and_read_observation_contract() {
    fn unpin<T: Unpin>(_: &T) {}
    let executor = Executor::new();
    let now = Instant::now();
    let deadline = now + Duration::from_secs(60);
    let mut sleep: Sleep = executor.sleep_until(deadline);
    unpin(&sleep);
    assert_eq!(sleep.deadline(), deadline);
    assert!(!sleep.is_elapsed());
    assert_eq!(executor.next_deadline(), None);
    let waker = noop_waker();
    assert!(
        Pin::new(&mut sleep)
            .poll(&mut Context::from_waker(&waker))
            .is_pending()
    );
    assert_eq!(executor.next_deadline(), Some(deadline));
    assert_eq!(executor.fire_timers(deadline), 1);
    assert!(sleep.is_elapsed());
    assert_eq!((&mut sleep).now_or_never(), Some(()));
    assert_eq!((&mut sleep).now_or_never(), Some(()));
    drop(sleep);
    assert_eq!(executor.next_deadline(), None);
    assert_eq!(Endpoint::null().read_ready(), Ok(true));
    assert_eq!(poll_timeout(false, None, now), -1);
    assert_eq!(
        poll_timeout(false, Some(now + Duration::from_micros(1)), now),
        1
    );
}
