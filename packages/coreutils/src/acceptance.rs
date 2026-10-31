//! Original cat, mkdir and seq implementations extracted from bash-web 81205d0.
use super::{Context, diagnostic, endpoint, write};
use std::fmt::Write as _;
use waffle_program_support::{
    executor::Budget,
    io::{Endpoint, FdTable, IoError, OpenOptions, open_path},
    path::absolute,
};

async fn copy(input: Endpoint, fds: &FdTable, context: &Context) -> Result<(), i32> {
    let mut buffer = [0u8; 8192];
    let mut budget = Budget::default();
    loop {
        budget.checkpoint(&context.cancel).await.map_err(|_| 130)?;
        let n = input
            .read_cancelled(&mut buffer, &context.cancel)
            .await
            .map_err(|e| e.status())?;
        if n == 0 {
            return Ok(());
        }
        write(fds, &buffer[..n], context).await?;
    }
}

pub(crate) async fn cat(
    args: Vec<String>,
    cwd: &str,
    fds: &FdTable,
    context: &Context,
) -> Result<(), i32> {
    if args.is_empty() {
        return copy(endpoint(fds, 0)?, fds, context).await;
    }
    for path in args {
        cat_path(&path, cwd, fds, context).await?;
    }
    Ok(())
}
async fn cat_path(path: &str, cwd: &str, fds: &FdTable, context: &Context) -> Result<(), i32> {
    let path = absolute(cwd, path);
    let options = OpenOptions::default();
    let opening = open_path(&path, fds, &options).map_err(|error| error.status())?;
    let input = context
        .cancel
        .run(opening.open(context.fs(), &options))
        .await
        .map_err(|_| 130)?
        .map_err(|error| error.status())?;
    copy(input, fds, context).await
}
pub(crate) async fn mkdir(
    args: Vec<String>,
    cwd: &str,
    fds: &FdTable,
    context: &Context,
) -> Result<i32, i32> {
    let mut parents = false;
    let mut operands = Vec::new();
    let mut options = true;
    for arg in args {
        match arg.as_str() {
            "--" if options => options = false,
            "-p" if options => parents = true,
            s if options && s.starts_with('-') && s != "-" => return Err(2),
            _ => operands.push(arg),
        }
    }
    if operands.is_empty() {
        return Err(2);
    }
    let mut status = 0;
    let mut budget = Budget::default();
    for operand in operands {
        budget.checkpoint(&context.cancel).await.map_err(|_| 130)?;
        // Empty operands must not turn into the current directory under -p.
        let path = if operand.is_empty() {
            String::new()
        } else {
            absolute(cwd, &operand)
        };
        let result = context
            .cancel
            .run(context.fs().mkdir(&path, parents))
            .await
            .map_err(|_| 130)?;
        let Err(error) = result else {
            continue;
        };
        status = 1;
        mkdir_error(&operand, error, fds, context).await?;
    }
    Ok(status)
}
async fn mkdir_error(
    operand: &str,
    error: IoError,
    fds: &FdTable,
    context: &Context,
) -> Result<(), i32> {
    diagnostic(fds, context, "mkdir", &format!("{operand}: {error}")).await
}
pub(crate) async fn seq(args: &[String], fds: &FdTable, context: &Context) -> Result<(), i32> {
    let (start, end) = match args {
        [end] => (1, end.parse::<i64>().map_err(|_| 2)?),
        [start, end] => (
            start.parse::<i64>().map_err(|_| 2)?,
            end.parse::<i64>().map_err(|_| 2)?,
        ),
        _ => return Err(2),
    };
    let mut buffer = String::new();
    let mut budget = Budget::default();
    for n in start..=end {
        budget.checkpoint(&context.cancel).await.map_err(|_| 130)?;
        writeln!(&mut buffer, "{n}").map_err(|_| 1)?;
        if buffer.len() >= 8192 {
            write(fds, buffer.as_bytes(), context).await?;
            buffer.clear();
        }
    }
    write(fds, buffer.as_bytes(), context).await?;
    Ok(())
}
