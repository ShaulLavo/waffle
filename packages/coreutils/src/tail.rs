use super::{Context, diagnostic, endpoint};
use std::collections::VecDeque;
use waffle_program_support::{
    executor::Budget,
    io::{Endpoint, FdTable, IoError, OpenOptions, open_path},
    path::absolute,
};

const MAX_RETAINED_BYTES: usize = 16 * 1024 * 1024;

struct Options {
    lines: usize,
    file: String,
}

impl Options {
    fn parse(args: Vec<String>) -> Result<Self, String> {
        let mut lines = 10;
        let mut file = None;
        let mut options = true;
        let mut args = args.into_iter();
        while let Some(arg) = args.next() {
            if options && arg == "--" {
                options = false;
                continue;
            }
            if options && arg == "-n" {
                let count = args.next().ok_or("option -n requires a line count")?;
                lines = parse_count(&count)?;
                continue;
            }
            if options && arg.starts_with("-n") && arg.len() > 2 {
                lines = parse_count(&arg[2..])?;
                continue;
            }
            if options && arg.starts_with('-') && arg != "-" {
                return Err(format!("unsupported option: {arg}"));
            }
            if file.replace(arg).is_some() {
                return Err("only one input file is supported".into());
            }
        }
        Ok(Self {
            lines,
            file: file.unwrap_or_else(|| "-".into()),
        })
    }
}

fn parse_count(count: &str) -> Result<usize, String> {
    if count.is_empty() || !count.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!("invalid line count: {count}"));
    }
    count
        .parse()
        .map_err(|_| format!("invalid line count: {count}"))
}

struct TailError {
    status: i32,
    message: String,
}

impl TailError {
    fn io(scope: &str, error: IoError) -> Self {
        Self {
            status: io_status(&error),
            message: format!("{scope}: {error}"),
        }
    }

    fn cancelled() -> Self {
        Self {
            status: 130,
            message: "interrupted".into(),
        }
    }

    fn retention_limit() -> Self {
        Self {
            status: 1,
            message: format!("retained input exceeds {MAX_RETAINED_BYTES} bytes"),
        }
    }
}

fn io_status(error: &IoError) -> i32 {
    match error {
        IoError::Cancelled => 130,
        IoError::BrokenPipe => 141,
        _ => 1,
    }
}

async fn fail(fds: &FdTable, context: &Context, error: TailError) -> Result<i32, i32> {
    if !matches!(error.status, 130 | 141) {
        diagnostic(fds, context, "tail", &error.message).await?;
    }
    Err(error.status)
}

async fn open_input(
    file: &str,
    cwd: &str,
    fds: &FdTable,
    context: &Context,
) -> Result<Endpoint, TailError> {
    if file == "-" {
        return endpoint(fds, 0).map_err(|status| TailError {
            status,
            message: "standard input is unavailable".into(),
        });
    }
    let path = absolute(cwd, file);
    let options = OpenOptions::default();
    let opening = open_path(&path, fds, &options).map_err(|error| TailError::io(file, error))?;
    context
        .cancel
        .run(opening.open(context.fs(), &options))
        .await
        .map_err(|_| TailError::cancelled())?
        .map_err(|error| TailError::io(file, error))
}

fn append_retained(
    current: &mut Vec<u8>,
    chunk: &[u8],
    retained_bytes: &mut usize,
) -> Result<(), TailError> {
    let total = retained_bytes
        .checked_add(chunk.len())
        .ok_or_else(TailError::retention_limit)?;
    if total > MAX_RETAINED_BYTES {
        return Err(TailError::retention_limit());
    }
    current.extend_from_slice(chunk);
    *retained_bytes = total;
    Ok(())
}

fn retain_record(
    records: &mut VecDeque<Vec<u8>>,
    record: Vec<u8>,
    retained_bytes: &mut usize,
    limit: usize,
) {
    if records.len() == limit {
        let removed = records.pop_front().expect("tail record deque is non-empty");
        *retained_bytes -= removed.len();
    }
    records.push_back(record);
}

fn retain_chunk(
    records: &mut VecDeque<Vec<u8>>,
    current: &mut Vec<u8>,
    mut chunk: &[u8],
    retained_bytes: &mut usize,
    limit: usize,
) -> Result<(), TailError> {
    if limit == 0 {
        return Ok(());
    }
    while let Some(newline) = chunk.iter().position(|byte| *byte == b'\n') {
        append_retained(current, &chunk[..=newline], retained_bytes)?;
        retain_record(records, std::mem::take(current), retained_bytes, limit);
        chunk = &chunk[newline + 1..];
    }
    append_retained(current, chunk, retained_bytes)
}

async fn read_tail(
    input: Endpoint,
    file: &str,
    limit: usize,
    context: &Context,
) -> Result<VecDeque<Vec<u8>>, TailError> {
    let mut records = VecDeque::with_capacity(limit.min(1024));
    let mut current = Vec::new();
    let mut retained_bytes = 0;
    let mut buffer = [0; 8192];
    let mut budget = Budget::default();
    loop {
        budget
            .checkpoint(&context.cancel)
            .await
            .map_err(|_| TailError::cancelled())?;
        let count = input
            .read_cancelled(&mut buffer, &context.cancel)
            .await
            .map_err(|error| TailError::io(file, error))?;
        if count == 0 {
            break;
        }
        retain_chunk(
            &mut records,
            &mut current,
            &buffer[..count],
            &mut retained_bytes,
            limit,
        )?;
    }
    if !current.is_empty() {
        retain_record(&mut records, current, &mut retained_bytes, limit);
    }
    Ok(records)
}

async fn write_output(fds: &FdTable, bytes: &[u8], context: &Context) -> Result<(), TailError> {
    let output = endpoint(fds, 1).map_err(|status| TailError {
        status,
        message: "standard output is unavailable".into(),
    })?;
    output
        .write_all(bytes, &context.cancel)
        .await
        .map_err(|error| TailError::io("standard output", error))
}

pub(crate) async fn run(
    args: Vec<String>,
    cwd: &str,
    fds: &FdTable,
    context: &Context,
) -> Result<i32, i32> {
    let options = match Options::parse(args) {
        Ok(options) => options,
        Err(error) => {
            diagnostic(fds, context, "tail", &error).await?;
            return Err(2);
        }
    };
    let input = match open_input(&options.file, cwd, fds, context).await {
        Ok(input) => input,
        Err(error) => return fail(fds, context, error).await,
    };
    let records = match read_tail(input, &options.file, options.lines, context).await {
        Ok(records) => records,
        Err(error) => return fail(fds, context, error).await,
    };
    for record in records {
        if let Err(error) = write_output(fds, &record, context).await {
            return fail(fds, context, error).await;
        }
    }
    Ok(0)
}
