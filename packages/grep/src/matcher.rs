//! Adapted subset of Bashkit's GrepOptions/FileScan/scan_input in
//! crates/bashkit/src/builtins/grep.rs, MIT, revision
//! 491c3281f668b76d64b15210b8f5d7bf97244be0. See
//! ../provenance/bashkit.source.json.
//! Original descriptor adapter, bounded record reader and small BRE translator;
//! no upstream whole-file reads, output accumulation or backtracking matcher.
//! The -e/-H/-h extension and locked regex receipt are in
//! ../provenance/grep.source.json.
use super::{Context, endpoint, write};
use regex::bytes::{Regex, RegexBuilder};
use waffle_program_support::{
    executor::Budget,
    io::{Endpoint, FdTable, IoError, OpenOptions, open_path},
    path::absolute,
};

const PATTERN_BYTES: usize = 4096;
const REGEX_BYTES: usize = 256 * 1024;
const RECORD_BYTES: usize = 64 * 1024;

#[derive(Default)]
struct Options {
    invert: bool,
    count: bool,
    quiet: bool,
    numbers: bool,
    ignore_case: bool,
    syntax: Syntax,
    filename: Option<bool>,
}
#[derive(Clone, Copy, Default, PartialEq)]
enum Syntax {
    #[default]
    Basic,
    Extended,
    Fixed,
}
impl Options {
    fn parse(args: Vec<String>) -> Result<(Self, Vec<String>, Vec<String>), String> {
        let mut options = Self::default();
        let mut operands = Vec::new();
        let mut patterns = Vec::new();
        let mut flags = true;
        let mut args = args.into_iter();
        while let Some(arg) = args.next() {
            if flags && arg == "--" {
                flags = false;
                continue;
            }
            if flags && arg.starts_with('-') && arg != "-" {
                options.short_options(&arg[1..], &mut args, &mut patterns)?;
                continue;
            }
            operands.push(arg);
        }
        if patterns.is_empty() {
            if operands.is_empty() {
                return Err("missing pattern".into());
            }
            patterns.push(operands.remove(0));
        }
        Ok((options, patterns, operands))
    }
    fn short_options(
        &mut self,
        arg: &str,
        args: &mut impl Iterator<Item = String>,
        patterns: &mut Vec<String>,
    ) -> Result<(), String> {
        for (index, flag) in arg.char_indices() {
            if flag == 'e' {
                let tail = &arg[index + 1..];
                let pattern = if tail.is_empty() {
                    args.next().ok_or("option requires an argument: -e")?
                } else {
                    tail.to_owned()
                };
                patterns.push(pattern);
                return Ok(());
            }
            self.flag(flag)?;
        }
        Ok(())
    }
    fn flag(&mut self, flag: char) -> Result<(), String> {
        match flag {
            'v' => self.invert = true,
            'c' => self.count = true,
            'q' => self.quiet = true,
            'n' => self.numbers = true,
            'i' => self.ignore_case = true,
            'H' => self.filename = Some(true),
            'h' => self.filename = Some(false),
            'F' | 'E' => return self.matcher(flag),
            _ => return Err(format!("unsupported option: -{flag}")),
        }
        Ok(())
    }
    fn matcher(&mut self, flag: char) -> Result<(), String> {
        let syntax = if flag == 'F' {
            Syntax::Fixed
        } else {
            Syntax::Extended
        };
        if self.syntax != Syntax::Basic && self.syntax != syntax {
            return Err("conflicting matchers specified".into());
        }
        self.syntax = syntax;
        Ok(())
    }
    fn compile(&self, patterns: &[String]) -> Result<Regex, String> {
        let bytes = patterns.iter().try_fold(0usize, |total, pattern| {
            total
                .checked_add(pattern.len())
                .and_then(|n| n.checked_add(1))
        });
        if bytes.is_none_or(|bytes| bytes > PATTERN_BYTES + 1) {
            return Err("pattern byte limit exceeded".into());
        }
        // GNU/Bashkit treat newline-separated patterns as alternatives. Group
        // them so anchors remain local, without adding any capturing groups.
        let mut translated = String::new();
        for pattern in patterns.iter().flat_map(|pattern| pattern.split('\n')) {
            if !translated.is_empty() {
                translated.push('|');
            }
            translated.push_str("(?:");
            translated.push_str(&match self.syntax {
                Syntax::Fixed => regex::escape(pattern),
                Syntax::Extended => pattern.to_owned(),
                Syntax::Basic => basic_pattern(pattern)?,
            });
            translated.push(')');
        }
        RegexBuilder::new(&translated)
            .case_insensitive(self.ignore_case)
            .size_limit(REGEX_BYTES)
            .dfa_size_limit(REGEX_BYTES)
            .nest_limit(64)
            .build()
            .map_err(|error| error.to_string())
    }
}

fn basic_bracket(ch: char, bracket: &mut bool, bracket_first: &mut bool, result: &mut String) {
    if ch == ']' && !*bracket_first {
        *bracket = false;
    }
    // GNU BRE backslashes are literal inside brackets.
    if ch == '\\' {
        result.push('\\');
    }
    result.push(ch);
    if !(*bracket_first && ch == '^') {
        *bracket_first = false;
    }
}

fn open_basic_bracket(
    chars: &mut std::iter::Peekable<std::str::Chars>,
    bracket: &mut bool,
    bracket_first: &mut bool,
    branch_start: &mut bool,
    result: &mut String,
) {
    *branch_start = false;
    *bracket = true;
    *bracket_first = true;
    result.push('[');
    // regex requires an escaped initial literal closing bracket.
    if chars.peek() == Some(&']') {
        chars.next();
        result.push_str("\\]");
        *bracket_first = false;
    }
}

fn basic_caret(branch_start: &mut bool, result: &mut String) {
    if !*branch_start {
        result.push('\\');
    }
    result.push('^');
    *branch_start = false;
}

fn basic_dollar(
    chars: &std::iter::Peekable<std::str::Chars>,
    branch_start: &mut bool,
    result: &mut String,
) {
    // Only inspect the next two characters: no suffix allocation or
    // rescan, and escaped literal backslashes cannot open a branch.
    let mut tail = chars.clone();
    let branch_end = match tail.next() {
        None => true,
        Some('\\') => matches!(tail.next(), Some(')' | '|')),
        _ => false,
    };
    if !branch_end {
        result.push('\\');
    }
    result.push('$');
    *branch_start = false;
}

fn basic_escape(
    chars: &mut std::iter::Peekable<std::str::Chars>,
    branch_start: &mut bool,
    result: &mut String,
) -> Result<(), String> {
    let next = chars.next().ok_or("trailing backslash")?;
    *branch_start = matches!(next, '(' | '|');
    if matches!(next, '(' | ')' | '+' | '?' | '|' | '{' | '}') {
        result.push(next);
        return Ok(());
    }
    result.push('\\');
    result.push(next);
    Ok(())
}

/// Original deliberately small GNU BRE adapter, not Bashkit's full grep_pattern
/// implementation. Unescaped ()+?|{} are literals, their escaped forms are
/// operators outside brackets. A caret anchors only at branch start and a
/// dollar only at branch end (including escaped BRE groups/alternation).
/// Backreferences are rejected by the linear-time regex engine, not routed
/// through a potentially backtracking fallback.
fn basic_pattern(pattern: &str) -> Result<String, String> {
    let mut result = String::new();
    let mut chars = pattern.chars().peekable();
    let mut bracket = false;
    let mut bracket_first = false;
    let mut branch_start = true;
    while let Some(ch) = chars.next() {
        if bracket {
            basic_bracket(ch, &mut bracket, &mut bracket_first, &mut result);
            continue;
        }
        match ch {
            '[' => open_basic_bracket(
                &mut chars,
                &mut bracket,
                &mut bracket_first,
                &mut branch_start,
                &mut result,
            ),
            '\\' => basic_escape(&mut chars, &mut branch_start, &mut result)?,
            '^' => basic_caret(&mut branch_start, &mut result),
            '$' => basic_dollar(&chars, &mut branch_start, &mut result),
            '(' | ')' | '+' | '?' | '|' | '{' | '}' => {
                result.push('\\');
                result.push(ch);
                branch_start = false;
            }
            _ => {
                result.push(ch);
                branch_start = false;
            }
        }
    }
    Ok(result)
}

async fn diagnostic(fds: &FdTable, context: &Context, message: &str) -> Result<(), i32> {
    if let Some(stderr) = fds.get(2) {
        stderr
            .write_all(format!("grep: {message}\n").as_bytes(), &context.cancel)
            .await
            .map_err(|error| error.status())?;
    }
    Ok(())
}
fn io_status(error: IoError) -> i32 {
    match error {
        IoError::Cancelled => 130,
        IoError::BrokenPipe => 141,
        _ => 2,
    }
}

struct Scan<'a> {
    options: &'a Options,
    matcher: &'a Regex,
    // Multiple operands prefix by default; -H/-h can override that choice.
    filename: Option<&'a str>,
    fds: &'a FdTable,
    context: &'a Context,
    line_number: u64,
    selected: u64,
}
impl Scan<'_> {
    async fn line(&mut self, record: &[u8]) -> Result<bool, i32> {
        self.line_number += 1;
        if self.matcher.is_match(record) == self.options.invert {
            return Ok(false);
        }
        self.selected += 1;
        if self.options.quiet {
            return Ok(true);
        }
        if self.options.count {
            return Ok(false);
        }
        self.prefix().await?;
        if self.options.numbers {
            write(
                self.fds,
                format!("{}:", self.line_number).as_bytes(),
                self.context,
            )
            .await?;
        }
        write(self.fds, record, self.context).await?;
        // grep terminates even the final unterminated selected record.
        write(self.fds, b"\n", self.context).await?;
        Ok(false)
    }
    async fn prefix(&self) -> Result<(), i32> {
        if let Some(filename) = self.filename {
            write(self.fds, filename.as_bytes(), self.context).await?;
            write(self.fds, b":", self.context).await?;
        }
        Ok(())
    }
    fn push_byte(record: &mut Vec<u8>, byte: u8, limit: usize) -> Result<(), i32> {
        if record.len() >= limit {
            return Err(2);
        }
        record.push(byte);
        Ok(())
    }
    async fn chunk(
        &mut self,
        chunk: &[u8],
        record: &mut Vec<u8>,
        budget: &mut Budget,
        limit: usize,
    ) -> Result<bool, i32> {
        for &byte in chunk {
            budget
                .checkpoint(&self.context.cancel)
                .await
                .map_err(|_| 130)?;
            if byte != b'\n' {
                Self::push_byte(record, byte, limit)?;
                continue;
            }
            if self.line(record).await? {
                return Ok(true);
            }
            record.clear();
        }
        Ok(false)
    }
    async fn finish_record(&mut self, record: &[u8]) -> Result<(), i32> {
        if !record.is_empty() {
            self.line(record).await?;
        }
        Ok(())
    }
    async fn input(&mut self, input: Endpoint) -> Result<(), i32> {
        let mut chunk = [0; 8192];
        let mut record = Vec::new();
        let mut budget = Budget::default();
        let limit = self.context.line_bytes.min(RECORD_BYTES);
        loop {
            budget
                .checkpoint(&self.context.cancel)
                .await
                .map_err(|_| 130)?;
            let count = input
                .read_cancelled(&mut chunk, &self.context.cancel)
                .await
                .map_err(io_status)?;
            if count == 0 {
                self.finish_record(&record).await?;
                break;
            }
            if self
                .chunk(&chunk[..count], &mut record, &mut budget, limit)
                .await?
            {
                return Ok(());
            }
        }
        if self.options.count && !self.options.quiet {
            self.prefix().await?;
            write(
                self.fds,
                format!("{}\n", self.selected).as_bytes(),
                self.context,
            )
            .await?;
        }
        Ok(())
    }
}

async fn open_input(
    file: &str,
    cwd: &str,
    fds: &FdTable,
    context: &Context,
) -> Result<Endpoint, i32> {
    if file == "-" {
        return endpoint(fds, 0).map_err(|_| 2);
    }
    let path = absolute(cwd, file);
    let options = OpenOptions::default();
    let opening = open_path(&path, fds, &options).map_err(io_status)?;
    context
        .cancel
        .run(opening.open(context.fs(), &options))
        .await
        .map_err(|_| 130)?
        .map_err(io_status)
}

pub(crate) async fn run(
    args: Vec<String>,
    cwd: &str,
    fds: &FdTable,
    context: &Context,
) -> Result<i32, i32> {
    let (options, pattern, mut files) = match Options::parse(args) {
        Ok(parsed) => parsed,
        Err(error) => {
            diagnostic(fds, context, &error).await?;
            return Err(2);
        }
    };
    let matcher = match options.compile(&pattern) {
        Ok(matcher) => matcher,
        Err(error) => {
            diagnostic(fds, context, &error).await?;
            return Err(2);
        }
    };
    if files.is_empty() {
        files.push("-".into());
    }
    let filename = options.filename.unwrap_or(files.len() > 1);
    let mut found = false;
    let mut failed = false;
    let mut budget = Budget::default();
    for file in files {
        budget.checkpoint(&context.cancel).await.map_err(|_| 130)?;
        let input = open_input(&file, cwd, fds, context).await;
        let mut scan = Scan {
            options: &options,
            matcher: &matcher,
            filename: filename.then_some(if file == "-" {
                "(standard input)"
            } else {
                &file
            }),
            fds,
            context,
            line_number: 0,
            selected: 0,
        };
        let result = match input {
            Ok(input) => scan.input(input).await,
            Err(code) => Err(code),
        };
        match result {
            Err(code @ (130 | 141)) => return Err(code),
            Err(_) => {
                failed = true;
                diagnostic(
                    fds,
                    context,
                    &format!("{file}: read, output or record limit error"),
                )
                .await?;
            }
            Ok(()) => {}
        }
        found |= scan.selected > 0;
        // GNU quiet success takes priority over earlier input errors.
        if options.quiet && found {
            return Ok(0);
        }
    }
    Ok(if failed { 2 } else { i32::from(!found) })
}
