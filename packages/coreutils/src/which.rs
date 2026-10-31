//! Lookup of Waffle-registered programs, without loading or running candidates.
use std::io::Write;

struct Options {
    all: bool,
    names: Vec<String>,
}

impl Options {
    fn parse(args: &[String]) -> Result<Self, String> {
        let mut all = false;
        let mut options = true;
        let mut names = Vec::new();
        for arg in args {
            if options && arg == "--" {
                options = false;
                continue;
            }
            if options && matches!(arg.as_str(), "-a" | "--all") {
                all = true;
                continue;
            }
            if options && arg.starts_with('-') && arg != "-" {
                return Err(format!("unsupported option: {arg}"));
            }
            names.push(arg.clone());
        }
        if names.is_empty() {
            return Err("usage: which [-a|--all] [--] name...".into());
        }
        Ok(Self { all, names })
    }
}

pub struct Lookup<'a, F> {
    pub cwd: &'a str,
    pub path: Option<&'a str>,
    /// Returns a signed WASI errno on query failure, never a native X_OK result.
    pub registered: F,
}

impl<F: Fn(&str, &str) -> Result<bool, i32>> Lookup<'_, F> {
    fn report(&self, path: &str, output: &mut impl Write) -> Result<bool, i32> {
        if !(self.registered)(path, self.cwd)? {
            return Ok(false);
        }
        // Normalize only after the host has walked and admitted the original path.
        let absolute = waffle_program_support::path::absolute(self.cwd, path);
        writeln!(output, "{absolute}").map_err(|error| match error.kind() {
            std::io::ErrorKind::BrokenPipe => 141,
            _ => 1,
        })?;
        Ok(true)
    }

    fn find(&self, name: &str, all: bool, output: &mut impl Write) -> Result<bool, i32> {
        if name.contains('/') {
            return self.report(name, output);
        }
        let Some(path) = self.path else {
            return Ok(false);
        };
        let mut found = false;
        for directory in path.split(':') {
            let candidate = format!(
                "{}/{name}",
                if directory.is_empty() { "." } else { directory }
            );
            if !self.report(&candidate, output)? {
                continue;
            }
            found = true;
            if !all {
                break;
            }
        }
        Ok(found)
    }

    fn execute(&self, options: Options, output: &mut impl Write) -> Result<i32, i32> {
        let mut missing = false;
        for name in options.names {
            missing |= !self.find(&name, options.all, output)?;
        }
        Ok(i32::from(missing))
    }

    pub fn run(&self, args: &[String], output: &mut impl Write, errors: &mut impl Write) -> i32 {
        let options = match Options::parse(args) {
            Ok(options) => options,
            Err(message) => {
                let _ = writeln!(errors, "which: {message}");
                return 2;
            }
        };
        match self.execute(options, output) {
            Ok(status) => status,
            Err(errno) if errno < 0 => {
                let _ = writeln!(
                    errors,
                    "which: executable query failed: WASI errno {}",
                    -errno
                );
                2
            }
            Err(status) => status,
        }
    }
}
