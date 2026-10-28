//! Original MIT-licensed fixed-profile VT clear guest; see docs/clear.md.
use std::ffi::OsString;
use std::io::{self, Write};
use std::process::ExitCode;

fn sequence(
    mut args: impl Iterator<Item = OsString>,
    mut terminal: Option<OsString>,
) -> Result<&'static [u8], &'static str> {
    let mut keep_scrollback = false;
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("-x") => keep_scrollback = true,
            Some("-T") => terminal = Some(args.next().ok_or("-T requires a terminal name")?),
            Some("--") if args.next().is_none() => break,
            _ => return Err("usage: clear [-x] [-T terminal]"),
        }
    }
    let terminal = terminal.ok_or("TERM is not set; use -T xterm-256color")?;
    match terminal.to_str() {
        Some("xterm" | "xterm-256color" | "xterm-ghostty") if keep_scrollback => {
            Ok(b"\x1b[H\x1b[2J")
        }
        Some("xterm" | "xterm-256color" | "xterm-ghostty") => Ok(b"\x1b[H\x1b[2J\x1b[3J"),
        _ => Err("unsupported terminal; expected xterm, xterm-256color, or xterm-ghostty"),
    }
}

fn run() -> Result<(), String> {
    let bytes = sequence(std::env::args_os().skip(1), std::env::var_os("TERM"))?;
    let mut stdout = io::stdout().lock();
    stdout
        .write_all(bytes)
        .and_then(|()| stdout.flush())
        .map_err(|error| format!("write failed: {error}"))
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("clear: {error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::sequence;
    use std::ffi::OsString;

    fn output(args: &[&str], term: Option<&str>) -> Result<&'static [u8], &'static str> {
        sequence(args.iter().map(OsString::from), term.map(OsString::from))
    }

    #[test]
    fn profiles_and_scrollback() {
        for term in ["xterm", "xterm-256color", "xterm-ghostty"] {
            assert_eq!(
                output(&[], Some(term)),
                Ok(b"\x1b[H\x1b[2J\x1b[3J".as_slice())
            );
            assert_eq!(output(&["-x"], Some(term)), Ok(b"\x1b[H\x1b[2J".as_slice()));
        }
        assert_eq!(
            output(&["-T", "xterm", "-x"], None),
            Ok(b"\x1b[H\x1b[2J".as_slice())
        );
    }

    #[test]
    fn invalid_input_is_rejected_before_output() {
        for args in [
            vec!["-x", "-bad"],
            vec!["file"],
            vec!["-T"],
            vec!["--", "file"],
            vec!["-V"],
        ] {
            assert!(output(&args, Some("xterm")).is_err());
        }
        for term in [
            None,
            Some(""),
            Some("dumb"),
            Some("vt100"),
            Some("xterm-custom"),
        ] {
            assert!(output(&[], term).is_err());
        }
    }
}
