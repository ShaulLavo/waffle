use std::{
    io::Write,
    process::{Command, Output, Stdio},
};

pub fn run(binary: &str, args: &[&str], input: &[u8], clear_environment: bool) -> Output {
    let mut command = Command::new(binary);
    if clear_environment {
        command.env_clear();
    }
    let mut child = command
        .args(args)
        .env("LC_ALL", "C")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    child.wait_with_output().unwrap()
}
