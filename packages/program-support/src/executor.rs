//! A local executor: futures never move threads; only wake notifications are thread safe.
use futures::{
    future::LocalBoxFuture,
    task::{ArcWake, waker_ref},
};
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, VecDeque},
    future::Future,
    pin::Pin,
    rc::Rc,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll, Waker},
    time::Instant,
};

/// A host's race-safe idle primitive. `notify` must advance `epoch` before waking
/// the host; `park(observed)` may block ONLY if the epoch is still `observed`,
/// atomically with entering the wait. Browser hosts can instead use `drive` and
/// schedule another turn from `notify`; no blocking operation runs in a task.
pub trait IdleWakeSource: Send + Sync {
    fn epoch(&self) -> u64;
    fn notify(&self);
    fn park(&self, observed: u64);
}
struct ReadyQueue {
    ids: Mutex<VecDeque<usize>>,
    idle: Option<Arc<dyn IdleWakeSource>>,
}
struct TaskWake {
    id: usize,
    queued: AtomicBool,
    queue: Arc<ReadyQueue>,
}
impl ArcWake for TaskWake {
    fn wake_by_ref(this: &Arc<Self>) {
        if !this.queued.swap(true, Ordering::AcqRel) {
            this.queue.ids.lock().unwrap().push_back(this.id);
            if let Some(idle) = &this.queue.idle {
                idle.notify();
            }
        }
    }
}
struct Task {
    future: LocalBoxFuture<'static, ()>,
    wake: Arc<TaskWake>,
}
type TimerKey = (Instant, u64);

struct TimerEntry {
    elapsed: Rc<Cell<bool>>,
    waker: Waker,
}

#[derive(Default)]
struct TimerRegistry {
    entries: BTreeMap<TimerKey, TimerEntry>,
    next: u64,
}

impl TimerRegistry {
    fn register(&mut self, deadline: Instant, elapsed: Rc<Cell<bool>>, waker: &Waker) -> TimerKey {
        let sequence = self.next;
        self.next = sequence.checked_add(1).expect("timer sequence exhausted");
        let key = (deadline, sequence);
        self.entries.insert(
            key,
            TimerEntry {
                elapsed,
                waker: waker.clone(),
            },
        );
        key
    }
}

struct ExecutorState {
    tasks: RefCell<BTreeMap<usize, Task>>,
    next: Cell<usize>,
    queue: Arc<ReadyQueue>,
    driving: Cell<bool>,
    timers: Rc<RefCell<TimerRegistry>>,
}
#[derive(Clone)]
pub struct Executor(Rc<ExecutorState>);
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Drive {
    pub polls: usize,
    pub runnable: bool,
    pub pending: usize,
}
impl Default for Executor {
    fn default() -> Self {
        Self::new()
    }
}
impl Executor {
    pub fn new() -> Self {
        Self::make(None)
    }
    pub fn with_idle_source(idle: Arc<dyn IdleWakeSource>) -> Self {
        Self::make(Some(idle))
    }
    fn make(idle: Option<Arc<dyn IdleWakeSource>>) -> Self {
        Self(Rc::new(ExecutorState {
            tasks: RefCell::new(BTreeMap::new()),
            next: Cell::new(0),
            queue: Arc::new(ReadyQueue {
                ids: Mutex::new(VecDeque::new()),
                idle,
            }),
            driving: Cell::new(false),
            timers: Rc::new(RefCell::new(TimerRegistry::default())),
        }))
    }
    pub fn spawn<T: Clone + 'static>(
        &self,
        future: impl Future<Output = T> + 'static,
    ) -> JoinHandle<T> {
        let result = Rc::new(RefCell::new(None));
        let event = Event::default();
        let handle = JoinHandle {
            result: result.clone(),
            event: event.clone(),
            waiting: None,
        };
        let id = self.0.next.get();
        self.0
            .next
            .set(id.checked_add(1).expect("task id exhausted"));
        let wake = Arc::new(TaskWake {
            id,
            queued: AtomicBool::new(false),
            queue: self.0.queue.clone(),
        });
        self.0.tasks.borrow_mut().insert(
            id,
            Task {
                wake: wake.clone(),
                future: Box::pin(async move {
                    *result.borrow_mut() = Some(future.await);
                    event.notify();
                }),
            },
        );
        ArcWake::wake_by_ref(&wake);
        handle
    }
    /// Create a fused, removable timer future without retaining the task map.
    pub fn sleep_until(&self, deadline: Instant) -> Sleep {
        Sleep {
            registry: self.0.timers.clone(),
            deadline,
            key: None,
            elapsed: Rc::new(Cell::new(false)),
        }
    }
    /// Return the earliest deadline among currently registered timers.
    pub fn next_deadline(&self) -> Option<Instant> {
        self.0
            .timers
            .borrow()
            .entries
            .first_key_value()
            .map(|(key, _)| key.0)
    }
    /// Fire all timers at or before `now`, waking tasks after releasing the
    /// timer registry borrow. Equal deadlines retain registration order.
    pub fn fire_timers(&self, now: Instant) -> usize {
        let mut wakers = Vec::new();
        {
            let mut timers = self.0.timers.borrow_mut();
            while timers
                .entries
                .first_key_value()
                .is_some_and(|(key, _)| key.0 <= now)
            {
                let (_, entry) = timers.entries.pop_first().unwrap();
                entry.elapsed.set(true);
                wakers.push(entry.waker);
            }
        }
        let fired = wakers.len();
        for waker in wakers {
            waker.wake();
        }
        fired
    }
    fn has_timers(&self) -> bool {
        !self.0.timers.borrow().entries.is_empty()
    }
    /// Nonblocking host turn, bounded even if tasks continually yield to themselves.
    pub fn drive(&self, max_polls: usize) -> Drive {
        #[cfg(any(test, feature = "stack-observation"))]
        let marker = 0u8;
        #[cfg(any(test, feature = "stack-observation"))]
        observation::measure_driver(&marker);
        assert!(
            !self.0.driving.replace(true),
            "executor drive is not reentrant"
        );
        struct Reset<'a>(&'a Cell<bool>);
        impl Drop for Reset<'_> {
            fn drop(&mut self) {
                self.0.set(false);
            }
        }
        let _reset = Reset(&self.0.driving);
        if self.has_timers() {
            self.fire_timers(Instant::now());
        }
        let mut polls = 0;
        while polls < max_polls {
            let id = self.0.queue.ids.lock().unwrap().pop_front();
            let Some(id) = id else { break };
            let task = self.0.tasks.borrow_mut().remove(&id);
            let Some(mut task) = task else { continue };
            task.wake.queued.store(false, Ordering::Release);
            let waker = waker_ref(&task.wake);
            polls += 1;
            if task
                .future
                .as_mut()
                .poll(&mut Context::from_waker(&waker))
                .is_pending()
            {
                self.0.tasks.borrow_mut().insert(id, task);
            }
        }
        Drive {
            polls,
            runnable: !self.0.queue.ids.lock().unwrap().is_empty(),
            pending: self.0.tasks.borrow().len(),
        }
    }
    /// Snapshot first, then check readiness: a notification anywhere in between
    /// the check and the host wait makes `park` return without sleeping.
    /// Armed timers prevent parking because `IdleWakeSource::park` has no timeout.
    pub fn park_if_idle(&self) -> bool {
        if self.has_timers() {
            return false;
        }
        let Some(idle) = &self.0.queue.idle else {
            return false;
        };
        let epoch = idle.epoch();
        if self.0.driving.get()
            || !self.0.queue.ids.lock().unwrap().is_empty()
            || self.0.tasks.borrow().is_empty()
        {
            return false;
        }
        idle.park(epoch);
        true
    }
}

/// A fused executor timer. It registers on first poll, updates its waker on
/// re-poll and unregisters itself when dropped. The timer registry is separate
/// from the executor task map, so a task may own its own `Sleep` safely.
pub struct Sleep {
    registry: Rc<RefCell<TimerRegistry>>,
    deadline: Instant,
    key: Option<TimerKey>,
    elapsed: Rc<Cell<bool>>,
}

impl Sleep {
    pub fn deadline(&self) -> Instant {
        self.deadline
    }

    pub fn is_elapsed(&self) -> bool {
        self.elapsed.get()
    }

    fn unregister(&mut self) {
        let Some(key) = self.key.take() else {
            return;
        };
        self.registry.borrow_mut().entries.remove(&key);
    }
}

impl Future for Sleep {
    type Output = ();

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        let this = self.get_mut();
        if this.elapsed.get() {
            return Poll::Ready(());
        }
        if this.key.is_none() && Instant::now() >= this.deadline {
            this.elapsed.set(true);
            return Poll::Ready(());
        }

        let mut registry = this.registry.borrow_mut();
        let key = *this.key.get_or_insert_with(|| {
            registry.register(this.deadline, this.elapsed.clone(), cx.waker())
        });
        let entry = registry.entries.get_mut(&key).unwrap();
        if !entry.waker.will_wake(cx.waker()) {
            entry.waker = cx.waker().clone();
        }
        Poll::Pending
    }
}

impl Drop for Sleep {
    fn drop(&mut self) {
        self.unregister();
    }
}

pub struct JoinHandle<T> {
    result: Rc<RefCell<Option<T>>>,
    event: Event,
    waiting: Option<EventWait>,
}
impl<T> Clone for JoinHandle<T> {
    fn clone(&self) -> Self {
        Self {
            result: self.result.clone(),
            event: self.event.clone(),
            waiting: None,
        }
    }
}
impl<T> JoinHandle<T> {
    /// Observe an already-completed operation without scheduling an executor task.
    pub fn ready(value: T) -> Self {
        Self {
            result: Rc::new(RefCell::new(Some(value))),
            event: Event::default(),
            waiting: None,
        }
    }
    pub fn is_finished(&self) -> bool {
        self.result.borrow().is_some()
    }
}
impl<T: Clone> Future for JoinHandle<T> {
    type Output = T;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<T> {
        let this = self.get_mut();
        loop {
            if this.waiting.is_none() {
                this.waiting = Some(this.event.listen());
            }
            if let Some(value) = this.result.borrow().as_ref().cloned() {
                this.waiting = None;
                return Poll::Ready(value);
            }
            if Pin::new(this.waiting.as_mut().unwrap())
                .poll(cx)
                .is_pending()
            {
                return Poll::Pending;
            }
            this.waiting = None;
        }
    }
}

#[derive(Default)]
struct EventState {
    epoch: u64,
    next: u64,
    waiters: BTreeMap<u64, Waker>,
}
/// Edge-triggered local notification with one removable registration per wait.
#[derive(Clone, Default)]
pub struct Event(Rc<RefCell<EventState>>);
impl Event {
    pub fn listen(&self) -> EventWait {
        EventWait {
            event: self.clone(),
            epoch: self.0.borrow().epoch,
            id: None,
        }
    }
    pub fn notify(&self) {
        let waiters = {
            let mut state = self.0.borrow_mut();
            state.epoch = state.epoch.wrapping_add(1);
            std::mem::take(&mut state.waiters)
        };
        for waker in waiters.into_values() {
            waker.wake();
        }
    }
    #[cfg(test)]
    pub(crate) fn waiter_count(&self) -> usize {
        self.0.borrow().waiters.len()
    }
}
/// One removable event registration. Dropping it unregisters its waker.
pub struct EventWait {
    event: Event,
    epoch: u64,
    id: Option<u64>,
}
impl Future for EventWait {
    type Output = ();
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        let this = self.get_mut();
        let mut state = this.event.0.borrow_mut();
        if state.epoch != this.epoch {
            if let Some(id) = this.id.take() {
                state.waiters.remove(&id);
            }
            return Poll::Ready(());
        }
        let id = *this.id.get_or_insert_with(|| {
            let id = state.next;
            state.next = id.checked_add(1).expect("wait id exhausted");
            id
        });
        match state.waiters.get_mut(&id) {
            Some(waker) if waker.will_wake(cx.waker()) => {}
            _ => {
                state.waiters.insert(id, cx.waker().clone());
            }
        }
        Poll::Pending
    }
}
impl Drop for EventWait {
    fn drop(&mut self) {
        if let Some(id) = self.id {
            self.event.0.borrow_mut().waiters.remove(&id);
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cancelled;
impl std::fmt::Display for Cancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("cancelled")
    }
}
impl std::error::Error for Cancelled {}
const HOST_PROBE_STRIDE: usize = 16;

struct CancelShared {
    flag: Cell<bool>,
    probe_remaining: Cell<usize>,
}

#[derive(Clone)]
pub struct Cancel {
    shared: Rc<CancelShared>,
    event: Event,
    probe: Option<Rc<dyn Fn() -> bool>>,
    parent: Option<Rc<Cancel>>,
}
impl Cancel {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn with_probe(probe: Rc<dyn Fn() -> bool>) -> Self {
        Self {
            shared: Rc::new(CancelShared {
                flag: Cell::new(false),
                probe_remaining: Cell::new(0),
            }),
            event: Event::default(),
            probe: Some(probe),
            parent: None,
        }
    }
    /// A reader-local abort must not cancel its caller. Parent interruption
    /// still reaches parked operations and descendants that outlive the reader.
    pub fn child(&self) -> Self {
        Self {
            parent: Some(Rc::new(self.clone())),
            ..Self::default()
        }
    }
    pub fn cancel(&self) {
        if !self.shared.flag.replace(true) {
            self.event.notify();
        }
    }
    /// Share cancellation state while suppressing host probes through all parents.
    pub fn without_probe(&self) -> Self {
        Self {
            shared: self.shared.clone(),
            event: self.event.clone(),
            probe: None,
            parent: self
                .parent
                .as_ref()
                .map(|parent| Rc::new(parent.without_probe())),
        }
    }
    pub fn is_cancelled(&self) -> bool {
        let shared = &*self.shared;
        if shared.flag.get() {
            return true;
        }
        if self
            .parent
            .as_ref()
            .is_some_and(|parent| parent.is_cancelled())
        {
            self.cancel();
            return true;
        }
        let Some(probe) = &self.probe else {
            return false;
        };
        let remaining = shared.probe_remaining.get();
        if remaining != 0 {
            shared.probe_remaining.set(remaining - 1);
            return false;
        }
        shared.probe_remaining.set(HOST_PROBE_STRIDE - 1);
        if probe() {
            self.cancel();
        }
        shared.flag.get()
    }
    /// Probe the consuming host interrupt immediately at parser and runtime
    /// boundaries that must not wait for the ordinary work stride.
    pub fn probe_now(&self) -> bool {
        let shared = &*self.shared;
        if shared.flag.get() {
            return true;
        }
        if self
            .parent
            .as_ref()
            .is_some_and(|parent| parent.probe_now())
            || self.probe.as_ref().is_some_and(|probe| probe())
        {
            self.cancel();
        }
        shared.flag.get()
    }
    pub async fn cancelled(&self) {
        let notification = self.event.listen();
        if !self.is_cancelled() {
            if let Some(parent) = &self.parent {
                let _ = futures::future::select(notification, Box::pin(parent.cancelled())).await;
            } else {
                notification.await;
            }
        }
    }
    /// Dropping this operation or losing the race removes both wait registrations.
    /// Cancellation wins ties and drops the inner future, unwinding its resources.
    pub async fn run<T>(&self, future: impl Future<Output = T>) -> Result<T, Cancelled> {
        let cancelled = self.cancelled();
        futures::pin_mut!(cancelled, future);
        match futures::future::select(cancelled, future).await {
            futures::future::Either::Left(_) => Err(Cancelled),
            futures::future::Either::Right((value, _)) => Ok(value),
        }
    }
}

impl Default for Cancel {
    fn default() -> Self {
        Self {
            shared: Rc::new(CancelShared {
                flag: Cell::new(false),
                probe_remaining: Cell::new(0),
            }),
            event: Event::default(),
            probe: None,
            parent: None,
        }
    }
}
/// Explicit work accounting; call on command dispatch, loop iterations and bounded
/// chunks of expansion/utility work, not just when I/O happens to block.
pub struct Budget {
    remaining: usize,
    quantum: usize,
}
impl Default for Budget {
    fn default() -> Self {
        Self::new(64)
    }
}
impl Budget {
    pub fn new(quantum: usize) -> Self {
        let quantum = quantum.max(1);
        Self {
            remaining: quantum,
            quantum,
        }
    }
    pub async fn checkpoint(&mut self, cancel: &Cancel) -> Result<(), Cancelled> {
        if cancel.is_cancelled() {
            return Err(Cancelled);
        }
        self.remaining -= 1;
        if self.remaining == 0 {
            self.remaining = self.quantum;
            yield_now().await;
        }
        if cancel.is_cancelled() {
            Err(Cancelled)
        } else {
            Ok(())
        }
    }
}
pub async fn yield_now() {
    let mut yielded = false;
    futures::future::poll_fn(move |cx| {
        if yielded {
            Poll::Ready(())
        } else {
            yielded = true;
            cx.waker().wake_by_ref();
            Poll::Pending
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::{
        FutureExt,
        task::{ArcWake, noop_waker, waker_ref},
    };
    use std::{sync::Mutex, thread, time::Duration};

    struct RecordingWake {
        id: u8,
        log: Arc<Mutex<Vec<u8>>>,
    }

    impl ArcWake for RecordingWake {
        fn wake_by_ref(this: &Arc<Self>) {
            this.log.lock().unwrap().push(this.id);
        }
    }

    fn recording_waker(log: &Arc<Mutex<Vec<u8>>>, id: u8) -> Waker {
        waker_ref(&Arc::new(RecordingWake {
            id,
            log: log.clone(),
        }))
        .clone()
    }

    fn assert_unpin<T: Unpin>() {}

    #[test]
    fn timers_register_order_fire_and_fuse() {
        assert_unpin::<Sleep>();
        let executor = Executor::new();
        let now = Instant::now();
        let first_deadline = now + Duration::from_secs(1);
        let second_deadline = now + Duration::from_secs(2);
        let log = Arc::new(Mutex::new(Vec::new()));
        let first_waker = recording_waker(&log, 1);
        let second_waker = recording_waker(&log, 2);
        let mut first = executor.sleep_until(first_deadline);
        let mut second = executor.sleep_until(second_deadline);
        let mut abandoned = executor.sleep_until(now + Duration::from_secs(3));
        let mut first_cx = Context::from_waker(&first_waker);
        let mut second_cx = Context::from_waker(&second_waker);
        let abandoned_waker = recording_waker(&log, 9);
        let mut abandoned_cx = Context::from_waker(&abandoned_waker);

        assert!(Pin::new(&mut second).poll(&mut second_cx).is_pending());
        assert!(Pin::new(&mut first).poll(&mut first_cx).is_pending());
        assert!(
            Pin::new(&mut abandoned)
                .poll(&mut abandoned_cx)
                .is_pending()
        );
        assert_eq!(executor.next_deadline(), Some(first_deadline));
        assert_eq!(executor.fire_timers(now), 0);
        drop(abandoned);
        assert_eq!(executor.next_deadline(), Some(first_deadline));
        assert_eq!(executor.fire_timers(first_deadline), 1);
        assert_eq!(*log.lock().unwrap(), vec![1]);
        assert!(first.is_elapsed());
        assert!(!second.is_elapsed());
        assert_eq!(executor.next_deadline(), Some(second_deadline));
        assert_eq!(Pin::new(&mut first).poll(&mut first_cx), Poll::Ready(()));
        assert_eq!(Pin::new(&mut first).poll(&mut first_cx), Poll::Ready(()));
        drop(first);
        assert_eq!(executor.next_deadline(), Some(second_deadline));
        assert_eq!(executor.fire_timers(second_deadline), 1);
        assert_eq!(*log.lock().unwrap(), vec![1, 2]);
        assert_eq!(Pin::new(&mut second).poll(&mut second_cx), Poll::Ready(()));
        drop(second);
        assert_eq!(executor.next_deadline(), None);
        assert_eq!(executor.fire_timers(now + Duration::from_secs(4)), 0);
    }

    #[test]
    fn timers_update_wakers_and_preserve_equal_deadline_order() {
        let executor = Executor::new();
        let deadline = Instant::now() + Duration::from_secs(1);
        let log = Arc::new(Mutex::new(Vec::new()));
        let first_waker = recording_waker(&log, 1);
        let updated_waker = recording_waker(&log, 2);
        let second_waker = recording_waker(&log, 3);
        let mut first = executor.sleep_until(deadline);
        let mut second = executor.sleep_until(deadline);
        assert!(
            Pin::new(&mut first)
                .poll(&mut Context::from_waker(&first_waker))
                .is_pending()
        );
        assert!(
            Pin::new(&mut first)
                .poll(&mut Context::from_waker(&updated_waker))
                .is_pending()
        );
        assert!(
            Pin::new(&mut second)
                .poll(&mut Context::from_waker(&second_waker))
                .is_pending()
        );
        assert_eq!(executor.fire_timers(deadline), 2);
        assert_eq!(*log.lock().unwrap(), vec![2, 3]);
    }

    #[test]
    fn busy_tasks_do_not_starve_expiry_within_one_rotation() {
        let executor = Executor::new();
        let fired = Rc::new(Cell::new(false));
        let timer_fired = fired.clone();
        let deadline = Instant::now() + Duration::from_secs(60);
        let timer = executor.sleep_until(deadline);
        let timer_task = executor.spawn(async move {
            timer.await;
            timer_fired.set(true);
        });
        let cancel = Cancel::new();
        let busy_cancel = cancel.clone();
        let busy = executor.spawn(async move {
            while !busy_cancel.is_cancelled() {
                yield_now().await;
            }
        });
        executor.drive(2);
        assert!(!timer_task.is_finished());
        assert_eq!(executor.fire_timers(deadline), 1);
        executor.drive(2);
        assert!(fired.get());
        assert!(timer_task.is_finished());
        cancel.cancel();
        executor.drive(8);
        assert!(busy.is_finished());
    }

    #[test]
    fn drive_fires_registered_timers_automatically() {
        let executor = Executor::new();
        let deadline = Instant::now() + Duration::from_millis(50);
        let mut timer = executor.sleep_until(deadline);
        let waker = noop_waker();
        assert!(
            Pin::new(&mut timer)
                .poll(&mut Context::from_waker(&waker))
                .is_pending()
        );
        thread::sleep(deadline.saturating_duration_since(Instant::now()));
        assert!(!timer.is_elapsed());
        assert_eq!(executor.drive(0).polls, 0);
        assert!(timer.is_elapsed());
        assert_eq!(executor.next_deadline(), None);
    }

    #[test]
    fn park_if_idle_refuses_to_park_with_an_armed_timer() {
        let idle = Arc::new(Idle {
            epoch: 0.into(),
            parks: 0.into(),
        });
        let executor = Executor::with_idle_source(idle.clone());
        let timer = executor.sleep_until(Instant::now() + Duration::from_secs(1));
        let task = executor.spawn(timer);
        executor.drive(1);
        assert!(!executor.park_if_idle());
        assert_eq!(idle.parks.load(Ordering::Relaxed), 0);
        executor.fire_timers(Instant::now() + Duration::from_secs(2));
        executor.drive(1);
        assert!(task.is_finished());
    }

    thread_local! {
        static WAKING_EXECUTOR: RefCell<Option<Executor>> = const { RefCell::new(None) };
    }

    struct ReentrantTimerWake;
    impl std::task::Wake for ReentrantTimerWake {
        fn wake(self: Arc<Self>) {
            WAKING_EXECUTOR.with(|slot| {
                let borrowed = slot.borrow();
                let executor = borrowed.as_ref().unwrap();
                assert_eq!(executor.next_deadline(), None);
                assert_eq!(executor.fire_timers(Instant::now()), 0);
            });
        }
    }

    #[test]
    fn fire_releases_the_registry_before_waking() {
        let executor = Executor::new();
        let deadline = Instant::now() + Duration::from_secs(60);
        let mut sleep = executor.sleep_until(deadline);
        let waker = Waker::from(Arc::new(ReentrantTimerWake));
        assert!(
            Pin::new(&mut sleep)
                .poll(&mut Context::from_waker(&waker))
                .is_pending()
        );
        WAKING_EXECUTOR.with(|slot| *slot.borrow_mut() = Some(executor.clone()));
        assert_eq!(executor.fire_timers(deadline), 1);
        WAKING_EXECUTOR.with(|slot| *slot.borrow_mut() = None);
    }

    #[test]
    fn timers_do_not_retain_the_task_map_and_drop_unregisters() {
        let executor = Executor::new();
        let observer = executor.sleep_until(Instant::now() + Duration::from_secs(60));
        let state = Rc::downgrade(&executor.0);
        let registry = observer.registry.clone();
        let sleep = executor.sleep_until(observer.deadline());
        executor.spawn(sleep);
        executor.drive(1);
        assert_eq!(registry.borrow().entries.len(), 1);
        drop(executor);
        assert!(state.upgrade().is_none());
        assert!(registry.borrow().entries.is_empty());
        drop(observer);
    }

    #[test]
    fn already_elapsed_sleep_never_registers() {
        let executor = Executor::new();
        let mut sleep = executor.sleep_until(Instant::now() - Duration::from_secs(1));
        assert_eq!(
            Pin::new(&mut sleep).poll(&mut Context::from_waker(&noop_waker())),
            Poll::Ready(())
        );
        assert!(sleep.is_elapsed());
        assert_eq!(executor.next_deadline(), None);
    }

    #[test]
    fn cancelling_or_dropping_a_sleep_removes_its_registration() {
        let executor = Executor::new();
        let deadline = Instant::now() + Duration::from_secs(60);
        let cancel = Cancel::new();
        let mut wait = Box::pin(cancel.run(executor.sleep_until(deadline)));
        let waker = noop_waker();
        assert!(
            wait.as_mut()
                .poll(&mut Context::from_waker(&waker))
                .is_pending()
        );
        assert_eq!(executor.next_deadline(), Some(deadline));
        cancel.cancel();
        assert_eq!(
            wait.as_mut().poll(&mut Context::from_waker(&waker)),
            Poll::Ready(Err(Cancelled))
        );
        drop(wait);
        assert_eq!(executor.next_deadline(), None);
        assert_eq!(cancel.event.waiter_count(), 0);

        let mut wait = executor.sleep_until(deadline);
        assert!(
            Pin::new(&mut wait)
                .poll(&mut Context::from_waker(&waker))
                .is_pending()
        );
        drop(wait);
        assert_eq!(executor.fire_timers(deadline), 0);
        assert_eq!(executor.next_deadline(), None);
    }

    #[test]
    fn spawn_join_and_fair_budget() {
        let ex = Executor::new();
        let cancel = Cancel::new();
        let iterations = Rc::new(Cell::new(0));
        let n = iterations.clone();
        let c = cancel.clone();
        let busy = ex.spawn(async move {
            let mut budget = Budget::new(2);
            loop {
                if budget.checkpoint(&c).await.is_err() {
                    break;
                }
                n.set(n.get() + 1);
            }
        });
        let other = ex.spawn(async { 42 });
        let turn = ex.drive(4);
        assert!(turn.runnable);
        assert!(other.is_finished());
        assert!(iterations.get() > 0);
        cancel.cancel();
        ex.drive(8);
        assert!(busy.is_finished());
        assert_eq!(other.clone().now_or_never(), Some(42));
        assert_eq!(other.now_or_never(), Some(42));
    }
    #[test]
    fn registration_is_updated_and_removed_on_drop() {
        let cancel = Cancel::new();
        let mut wait = Box::pin(cancel.cancelled());
        let waker = noop_waker();
        let mut cx = Context::from_waker(&waker);
        for _ in 0..1000 {
            assert!(wait.as_mut().poll(&mut cx).is_pending());
        }
        assert_eq!(cancel.event.waiter_count(), 1);
        drop(wait);
        assert_eq!(cancel.event.waiter_count(), 0);
        let mut operation = Box::pin(cancel.run(futures::future::pending::<()>()));
        assert!(operation.as_mut().poll(&mut cx).is_pending());
        cancel.cancel();
        assert_eq!(
            operation.as_mut().poll(&mut cx),
            Poll::Ready(Err(Cancelled))
        );
        assert_eq!(cancel.event.waiter_count(), 0);
    }
    #[test]
    fn child_cancellation_is_local_but_parent_wakes_parked_descendants() {
        let parent = Cancel::new();
        let child = parent.child();
        let grandchild = child.child();
        let mut wait = Box::pin(grandchild.cancelled());
        let waker = noop_waker();
        let mut cx = Context::from_waker(&waker);
        assert!(wait.as_mut().poll(&mut cx).is_pending());
        assert_eq!(parent.event.waiter_count(), 1);
        parent.cancel();
        assert!(wait.as_mut().poll(&mut cx).is_ready());
        drop(wait);
        assert!(grandchild.is_cancelled());
        assert_eq!(parent.event.waiter_count(), 0);

        let parent = Cancel::new();
        let child = parent.child();
        child.cancel();
        assert!(!parent.is_cancelled());
    }
    #[test]
    fn child_preserves_host_probe_and_without_probe_suppresses_it() {
        let interrupted = Rc::new(Cell::new(false));
        let observed = interrupted.clone();
        let parent = Cancel::with_probe(Rc::new(move || observed.get()));
        let child = parent.child();
        let passive = child.without_probe();
        interrupted.set(true);
        assert!(!passive.probe_now());
        assert!(child.probe_now());
        assert!(parent.is_cancelled());
        assert!(passive.is_cancelled());
    }
    #[test]
    fn notification_before_registration_and_nested_spawns() {
        let event = Event::default();
        let wait = event.listen();
        event.notify();
        assert_eq!(wait.now_or_never(), Some(()));
        assert_eq!(event.waiter_count(), 0);
        let ex = Executor::new();
        let nested = ex.clone();
        let task = ex.spawn(async move { nested.spawn(async { 17 }).await });
        assert_eq!(ex.drive(8).pending, 0);
        assert_eq!(task.now_or_never(), Some(17));
    }
    #[test]
    fn shared_join_waits_unregister_independently() {
        let ex = Executor::new();
        let gate = Event::default();
        let wait = gate.listen();
        let mut first = ex.spawn(async move {
            wait.await;
            9
        });
        let mut second = first.clone();
        let waker = noop_waker();
        let mut cx = Context::from_waker(&waker);
        for _ in 0..100 {
            assert!(Pin::new(&mut first).poll(&mut cx).is_pending());
        }
        assert!(Pin::new(&mut second).poll(&mut cx).is_pending());
        assert_eq!(first.event.waiter_count(), 2);
        drop(second);
        assert_eq!(first.event.waiter_count(), 1);
        ex.drive(1);
        assert_eq!(ex.drive(100).polls, 0); // parked tasks are never polled speculatively
        gate.notify();
        ex.drive(8);
        assert_eq!(first.event.waiter_count(), 0);
        assert_eq!(first.now_or_never(), Some(9));
    }
    struct Idle {
        epoch: std::sync::atomic::AtomicU64,
        parks: std::sync::atomic::AtomicUsize,
    }
    impl IdleWakeSource for Idle {
        fn epoch(&self) -> u64 {
            self.epoch.load(Ordering::Acquire)
        }
        fn notify(&self) {
            self.epoch.fetch_add(1, Ordering::Release);
        }
        fn park(&self, observed: u64) {
            if observed == self.epoch() {
                self.parks.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
    #[test]
    fn host_parks_only_without_runnable_tasks_and_wakes_on_interrupt() {
        let idle = Arc::new(Idle {
            epoch: 0.into(),
            parks: 0.into(),
        });
        let ex = Executor::with_idle_source(idle.clone());
        let cancel = Cancel::new();
        let c = cancel.clone();
        let task = ex.spawn(async move { c.cancelled().await });
        assert!(!ex.park_if_idle());
        ex.drive(10);
        assert!(ex.park_if_idle());
        assert_eq!(idle.parks.load(Ordering::Relaxed), 1);
        let before = idle.epoch();
        cancel.cancel();
        assert!(idle.epoch() > before);
        assert!(!ex.park_if_idle());
        ex.drive(10);
        assert!(task.is_finished());
        assert!(!ex.park_if_idle());
    }
}

#[cfg(any(test, feature = "stack-observation"))]
/// Development-only stack measurements. Absent unless testing this crate or
/// explicitly enabling `stack-observation` in a downstream dev-dependency.
pub mod observation {
    use std::cell::Cell;
    #[derive(Clone, Copy, Default, Debug)]
    pub struct StackObservation {
        driver: usize,
        pub poll_bytes: usize,
        pub drop_bytes: usize,
        pub calls: usize,
    }
    thread_local! { static STACK_OBSERVATION: Cell<StackObservation> = Cell::new(StackObservation::default()); }
    pub fn measure_driver(marker: &u8) {
        STACK_OBSERVATION.with(|slot| {
            let mut sample = slot.get();
            sample.driver = marker as *const u8 as usize;
            slot.set(sample);
        });
    }
    pub fn measure_poll(marker: &u8) {
        STACK_OBSERVATION.with(|slot| {
            let mut sample = slot.get();
            if sample.driver != 0 {
                sample.poll_bytes = sample
                    .poll_bytes
                    .max(sample.driver.abs_diff(marker as *const u8 as usize));
            }
            slot.set(sample);
        });
    }
    pub fn measure_drop(marker: &u8) {
        STACK_OBSERVATION.with(|slot| {
            let mut sample = slot.get();
            if sample.driver != 0 {
                sample.drop_bytes = sample
                    .drop_bytes
                    .max(sample.driver.abs_diff(marker as *const u8 as usize));
            }
            slot.set(sample);
        });
    }
    pub fn measure_calls(calls: usize) {
        STACK_OBSERVATION.with(|slot| {
            let mut sample = slot.get();
            sample.calls = sample.calls.max(calls);
            slot.set(sample);
        });
    }
    pub fn reset_stack_observation() {
        STACK_OBSERVATION.with(|slot| slot.set(StackObservation::default()));
    }
    pub fn stack_observation() -> StackObservation {
        STACK_OBSERVATION.with(Cell::get)
    }
}
