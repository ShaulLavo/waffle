use std::cell::Cell;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Barrier};
use std::thread;

static MAIN_STATIC: AtomicU32 = AtomicU32::new(17);
const MAIN_SENTINEL: u32 = 0x51a7_c0de;

thread_local! {
    static LOCAL: Cell<u32> = const { Cell::new(23) };
}

#[derive(Debug, PartialEq, Eq)]
struct ChildResult {
    id: u32,
    tls: u32,
    stack: [u32; 4],
    previous_progress: u32,
}

fn child(id: u32, barrier: Arc<Barrier>, progress: Arc<AtomicU32>) -> ChildResult {
    assert_eq!(MAIN_STATIC.load(Ordering::SeqCst), MAIN_SENTINEL);
    LOCAL.with(|local| {
        assert_eq!(local.get(), 23);
        local.set(100 + id);
    });
    let mut stack = [id, id + 1, id + 2, id + 3];
    std::hint::black_box(&mut stack);
    barrier.wait();
    let previous_progress = progress.fetch_add(1, Ordering::SeqCst);
    barrier.wait();
    assert_eq!(progress.load(Ordering::SeqCst), 2);
    assert_eq!(MAIN_STATIC.load(Ordering::SeqCst), MAIN_SENTINEL);
    ChildResult {
        id,
        tls: LOCAL.with(Cell::get),
        stack,
        previous_progress,
    }
}

fn pair() {
    let barrier = Arc::new(Barrier::new(3));
    let progress = Arc::new(AtomicU32::new(0));
    let first_barrier = Arc::clone(&barrier);
    let first_progress = Arc::clone(&progress);
    let first = thread::spawn(move || child(1, first_barrier, first_progress));
    let second_barrier = Arc::clone(&barrier);
    let second_progress = Arc::clone(&progress);
    let second = thread::spawn(move || child(2, second_barrier, second_progress));
    barrier.wait();
    barrier.wait();
    let first = first.join().expect("first child joins");
    let second = second.join().expect("second child joins");
    assert_eq!(first.id, 1);
    assert_eq!(second.id, 2);
    assert_eq!(first.tls, 101);
    assert_eq!(second.tls, 102);
    assert_eq!(first.stack, [1, 2, 3, 4]);
    assert_eq!(second.stack, [2, 3, 4, 5]);
    assert_eq!(first.previous_progress + second.previous_progress, 1);
    assert_eq!(progress.load(Ordering::SeqCst), 2);
    assert_eq!(LOCAL.with(Cell::get), 901);
    assert_eq!(MAIN_STATIC.load(Ordering::SeqCst), MAIN_SENTINEL);
}

fn nested_inner() -> (u32, [u32; 4]) {
    assert_eq!(LOCAL.with(Cell::get), 23);
    LOCAL.with(|local| local.set(702));
    assert_eq!(MAIN_STATIC.load(Ordering::SeqCst), MAIN_SENTINEL);
    (LOCAL.with(Cell::get), std::hint::black_box([72_u32; 4]))
}

fn nested() {
    let result = thread::spawn(|| {
        assert_eq!(LOCAL.with(Cell::get), 23);
        LOCAL.with(|local| local.set(701));
        let stack = std::hint::black_box([71_u32; 4]);
        let inner = thread::spawn(nested_inner);
        let inner = inner.join().expect("nested child joins");
        assert_eq!(LOCAL.with(Cell::get), 701);
        (LOCAL.with(Cell::get), stack, inner)
    })
    .join()
    .expect("outer child joins");
    assert_eq!(result, (701, [71; 4], (702, [72; 4])));
    assert_eq!(LOCAL.with(Cell::get), 901);
    assert_eq!(MAIN_STATIC.load(Ordering::SeqCst), MAIN_SENTINEL);
}

fn repeat() {
    for _ in 0..8 {
        pair();
    }
}

fn main() {
    MAIN_STATIC.store(MAIN_SENTINEL, Ordering::SeqCst);
    LOCAL.with(|local| local.set(901));
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mode = args.first().map(String::as_str).unwrap_or("pair");
    assert_eq!(
        args.len(),
        usize::from(!args.is_empty()),
        "one mode argument"
    );
    match mode {
        "pair" => pair(),
        "repeat" => repeat(),
        "nested" => nested(),
        _ => panic!("expected pair, repeat, or nested"),
    }
    println!("threads-ok mode={mode} main-static={MAIN_SENTINEL} main-tls=901");
}
