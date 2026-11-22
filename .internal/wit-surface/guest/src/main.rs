use std::{
    env, fs,
    hint::black_box,
    io::{Read, Write, stdin, stdout},
    time::Instant,
};

#[cfg(feature = "generated")]
wit_bindgen::generate!({ world: "guest" });

#[cfg(feature = "generated")]
use waffle::experiment::window::{Surface, acquire};

#[cfg(not(feature = "generated"))]
use handwritten::{Surface, acquire};

#[cfg(not(feature = "generated"))]
mod handwritten {
    #[repr(C)]
    #[derive(Default)]
    pub struct SurfaceInfo {
        pub width: u32,
        pub height: u32,
        pub scale_milli: u32,
        pub flags: u32,
    }

    #[link(wasm_import_module = "runtime_window")]
    unsafe extern "C" {
        fn surfaces(output: *mut u32, bytes: u32) -> i32;
        fn surface_info(id: u32, output: *mut SurfaceInfo) -> i32;
    }

    pub struct Surface(u32);

    impl Surface {
        pub fn info(&self) -> Option<SurfaceInfo> {
            let mut output = SurfaceInfo::default();
            (unsafe { surface_info(self.0, &mut output) } == 0).then_some(output)
        }
    }

    pub fn acquire(id: u32) -> Option<Surface> {
        let mut selected = 0;
        (unsafe { surfaces(&mut selected, 4) } == 1 && selected == id).then_some(Surface(id))
    }
}

fn sample(surface: &Surface) {
    let info = surface.info().expect("live surface");
    println!(
        "info {} {} {} {}",
        info.width, info.height, info.scale_milli, info.flags
    );
}

fn benchmark(surface: &Surface) {
    for _ in 0..7 {
        let start = Instant::now();
        let mut sum = 0;
        for _ in 0..100_000 {
            sum += black_box(surface.info().expect("live surface").width);
        }
        println!("batch {} {sum}", start.elapsed().as_nanos());
    }
}

fn wait_for_page() {
    println!("ready");
    stdout().flush().unwrap();
    stdin().read_exact(&mut [0]).unwrap();
}

fn main() {
    let mut args = env::args().skip(1);
    let id = args.next().unwrap().parse::<u32>().unwrap();
    let mode = args.next().unwrap();
    assert_eq!(fs::read_to_string("/probe.txt").unwrap(), "surface fixture");
    assert!(acquire(id + 1).is_none());
    let surface = acquire(id).expect("granted surface");
    sample(&surface);
    if mode == "bench" {
        benchmark(&surface);
        return;
    }
    wait_for_page();
    match mode.as_str() {
        "revoke" => {
            assert!(surface.info().is_none());
            drop(surface);
            assert!(acquire(id).is_none());
            println!("revoked");
        }
        "retire" => std::mem::forget(surface),
        "resize" => {
            sample(&surface);
            sample(&surface);
            drop(surface);
            drop(acquire(id).expect("surface still granted after drop"));
            println!("released");
        }
        _ => panic!("unexpected mode"),
    }
}
