// Local WASI execution and restrictions for upstream env. See ../wasi.patch and provenance.json.
use uucore::error::{UResult, USimpleError};

pub fn validate_options(matches: &clap::ArgMatches) -> UResult<()> {
    let signal_option = ["ignore-signal", "default-signal", "block-signal"]
        .into_iter()
        .any(|option| matches.contains_id(option));
    if signal_option || matches.get_flag("list-signal-handling") {
        return Err(USimpleError::new(
            125,
            "signal options are unsupported on WASI",
        ));
    }
    Ok(())
}

#[link(wasm_import_module = "runtime_proc")]
unsafe extern "C" {
    fn cwd(output: *mut u8, capacity: usize) -> i32;
}

pub fn initialize_cwd() -> UResult<()> {
    let mut bytes = vec![0; waffle_process_consumer::MAX_REQUEST_BYTES];
    let length = waffle_process_consumer::decode_host_result("cwd", unsafe {
        cwd(bytes.as_mut_ptr(), bytes.len())
    })
    .map_err(process_error)?;
    let path = bytes
        .get(..length as usize)
        .ok_or_else(|| USimpleError::new(125, "invalid process cwd length"))?;
    let path = std::str::from_utf8(path)
        .map_err(|_| USimpleError::new(125, "non-UTF-8 process cwd is unsupported"))?;
    std::env::set_current_dir(path)
        .map_err(|error| USimpleError::new(125, format!("cannot initialize cwd: {error}")))?;
    Ok(())
}

fn text(value: &std::ffi::OsStr) -> UResult<String> {
    value
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| USimpleError::new(125, "non-UTF-8 process strings are unsupported"))
}

pub fn run_program(
    program: &std::ffi::OsStr,
    argv0: &std::ffi::OsStr,
    args: &[&std::ffi::OsStr],
) -> UResult<()> {
    use waffle_process_consumer::{Request, inherited_descriptors, resolve_executable, run};
    let program = text(program)?;
    if program.is_empty() {
        return Err(USimpleError::new(127, "'': No such file or directory"));
    }
    let cwd = std::env::current_dir()
        .map_err(|error| USimpleError::new(125, format!("cannot read cwd: {error}")))?;
    let cwd = text(cwd.as_os_str())?;
    let env = std::env::vars_os()
        .map(|(key, value)| Ok((text(&key)?, text(&value)?)))
        .collect::<UResult<std::collections::BTreeMap<_, _>>>()?;
    let executable = resolve_executable(&program, env.get("PATH").map(String::as_str), &cwd)
        .map_err(process_error)?;
    let mut argv = vec![text(argv0)?];
    for arg in args {
        argv.push(text(arg)?);
    }
    let request = Request {
        executable,
        argv,
        env,
        cwd,
        fds: inherited_descriptors().map_err(process_error)?,
    };
    let outcome = run(&request).map_err(process_error)?;
    let status = outcome.shell_status();
    if status == 0 {
        return Ok(());
    }
    Err(status.into())
}

fn process_error(error: waffle_process_consumer::Error) -> Box<dyn uucore::error::UError> {
    use waffle_process_consumer::Error;
    let status = match error {
        Error::Host {
            operation: "access_take" | "spawn",
            errno: 44,
        } => 127,
        Error::Host {
            operation: "access_take" | "spawn",
            ..
        } => 126,
        Error::Interrupted(signal) => 128 + i32::from(signal),
        _ => 125,
    };
    USimpleError::new(status, error.to_string())
}
