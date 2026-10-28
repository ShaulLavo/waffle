//! Grep guest entry. Native Bash in-process registration stays with Bash tests.
mod matcher;

use std::rc::Rc;
use waffle_program_support::{
    executor::Cancel,
    io::{Endpoint, FdTable, FileSystem},
};

pub struct Context {
    pub cancel: Cancel,
    pub filesystem: Rc<dyn FileSystem>,
    pub line_bytes: usize,
}

impl Context {
    fn fs(&self) -> &dyn FileSystem {
        self.filesystem.as_ref()
    }
}

async fn write(fds: &FdTable, bytes: &[u8], context: &Context) -> Result<(), i32> {
    let output = endpoint(fds, 1)?;
    output
        .write_all(bytes, &context.cancel)
        .await
        .map_err(|error| error.status())
}

fn endpoint(fds: &FdTable, fd: u32) -> Result<Endpoint, i32> {
    fds.get(fd).ok_or(1)
}

pub struct Invocation {
    pub args: Vec<String>,
    pub env: std::collections::BTreeMap<String, String>,
    pub cwd: String,
    pub fds: FdTable,
    pub context: Context,
}

pub async fn grep(invocation: Invocation) -> i32 {
    let Invocation {
        args,
        cwd,
        fds,
        context,
        ..
    } = invocation;
    matcher::run(args, &cwd, &fds, &context)
        .await
        .unwrap_or_else(|status| status)
}

#[cfg(not(target_os = "wasi"))]
pub fn guest_main<F, Fut>(_program: F) -> !
where
    F: FnOnce(Invocation) -> Fut + 'static,
    Fut: std::future::Future<Output = i32> + 'static,
{
    eprintln!("this program requires wasm32-wasip1 and a runtime_proc host");
    std::process::exit(2);
}

/// Drive grep over generic Waffle descriptor and filesystem imports.
/// Needs Waffle's runtime_proc.inherited_fd launch descriptor list.
#[cfg(all(target_os = "wasi", feature = "cooperative-wasi"))]
pub fn guest_main<F, Fut>(program: F) -> !
where
    F: FnOnce(Invocation) -> Fut + 'static,
    Fut: std::future::Future<Output = i32> + 'static,
{
    use futures::FutureExt;
    use waffle_program_support::{
        DEFAULT_LINE_BYTES,
        executor::Executor,
        runtime::{Runtime, WasiAbi},
    };
    let abi = Rc::new(WasiAbi::new().expect("root preopen and inherited descriptors"));
    abi.handle_interrupts().expect("signal setup");
    let executor = Executor::new();
    let runtime = Runtime::new(abi);
    let fds = runtime.stdio().expect("inherited descriptors");
    let cancel = Cancel::new();
    let invocation = Invocation {
        args: std::env::args().skip(1).collect(),
        env: std::env::vars().collect(),
        cwd: std::env::var("PWD").unwrap_or_else(|_| "/".into()),
        fds,
        context: Context {
            cancel: cancel.clone(),
            filesystem: Rc::new(runtime.clone()),
            line_bytes: DEFAULT_LINE_BYTES,
        },
    };
    let job = executor.spawn(program(invocation));
    while !job.is_finished() {
        if runtime.take_interrupt() {
            cancel.cancel();
        }
        let turn = executor.drive(64);
        if !job.is_finished() {
            runtime
                .poll(if turn.runnable { 0 } else { -1 })
                .expect("poll");
        }
    }
    std::process::exit(job.now_or_never().unwrap())
}
