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
    io::{
        Endpoint, FdTable, FileKind, FileMetadata, IoError, MAX_PATH_BYTES, OpenOptions,
        descriptor_number, open_path,
    },
    path::absolute,
};

const PATTERN_BYTES: usize = 4096;
const REGEX_BYTES: usize = 256 * 1024;
const RECORD_BYTES: usize = 64 * 1024;
const MAX_EXCLUDE_DIRS: usize = 128;
const MAX_RECURSION_DEPTH: usize = 128;
const WASI_EISDIR: i32 = 31;

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum Recursive {
    #[default]
    None,
    /// `-r` / `--recursive`: descend directories; follow symlinks only for explicit CLI operands.
    FollowCommandLine,
    /// `-R` / `--dereference-recursive`: descend directories and follow all symlinks.
    DereferenceAll,
}

#[derive(Default)]
struct Options {
    invert: bool,
    count: bool,
    quiet: bool,
    numbers: bool,
    ignore_case: bool,
    syntax: Syntax,
    filename: Option<bool>,
    recursive: Recursive,
    exclude_dirs: Vec<String>,
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
            if flags && arg.starts_with("--") {
                options.long_option(&arg, &mut args)?;
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
    fn long_option(
        &mut self,
        arg: &str,
        args: &mut impl Iterator<Item = String>,
    ) -> Result<(), String> {
        if arg == "--recursive" {
            self.recursive = Recursive::FollowCommandLine;
            return Ok(());
        }
        if arg == "--dereference-recursive" {
            self.recursive = Recursive::DereferenceAll;
            return Ok(());
        }
        if let Some(pattern) = arg.strip_prefix("--exclude-dir=") {
            return self.add_exclude_dir(pattern.to_owned());
        }
        if arg == "--exclude-dir" {
            let pattern = args
                .next()
                .ok_or("option requires an argument: --exclude-dir")?;
            return self.add_exclude_dir(pattern);
        }
        Err(format!("unsupported option: {arg}"))
    }
    fn add_exclude_dir(&mut self, pattern: String) -> Result<(), String> {
        if self.exclude_dirs.len() >= MAX_EXCLUDE_DIRS {
            return Err("exclude-dir limit exceeded".into());
        }
        self.exclude_dirs.push(pattern);
        Ok(())
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
            'r' => self.recursive = Recursive::FollowCommandLine,
            'R' => self.recursive = Recursive::DereferenceAll,
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
enum ScanError {
    Fatal(i32),
    IsDirectory,
    Other,
}

fn scan_io_error(error: IoError) -> ScanError {
    match error {
        IoError::Cancelled => ScanError::Fatal(130),
        IoError::BrokenPipe => ScanError::Fatal(141),
        IoError::Runtime(WASI_EISDIR) => ScanError::IsDirectory,
        _ => ScanError::Other,
    }
}

fn write_error(status: i32) -> ScanError {
    match status {
        130 | 141 => ScanError::Fatal(status),
        _ => ScanError::Other,
    }
}

/// Linear-time wildcard matcher (`*` and `?`) for `--exclude-dir` basenames.
fn glob_matches(pattern: &str, text: &str) -> bool {
    let pat = pattern.as_bytes();
    let txt = text.as_bytes();
    let (mut p, mut t) = (0usize, 0usize);
    let mut star: Option<(usize, usize)> = None;
    while t < txt.len() {
        if p < pat.len() && pat[p] == b'*' {
            p += 1;
            star = Some((p, t));
            continue;
        }
        if p < pat.len() && (pat[p] == b'?' || pat[p] == txt[t]) {
            p += 1;
            t += 1;
            continue;
        }
        let Some((star_p, star_t)) = star else {
            return false;
        };
        let next_t = star_t + 1;
        star = Some((star_p, next_t));
        p = star_p;
        t = next_t;
    }
    while p < pat.len() && pat[p] == b'*' {
        p += 1;
    }
    p == pat.len()
}

fn dir_basename(display: &str) -> &str {
    let trimmed = display.trim_end_matches('/');
    if trimmed.is_empty() {
        return "/";
    }
    match trimmed.rsplit_once('/') {
        Some((_, name)) => name,
        None => trimmed,
    }
}

fn is_excluded_dir(name: &str, patterns: &[String]) -> bool {
    patterns.iter().any(|pattern| glob_matches(pattern, name))
}

fn join_display_path(parent: &str, child: &str) -> String {
    if parent.is_empty() {
        return child.to_owned();
    }
    if parent == "/" {
        return format!("/{child}");
    }
    if parent.ends_with('/') {
        return format!("{parent}{child}");
    }
    format!("{parent}/{child}")
}

fn join_absolute_path(parent: &str, child: &str) -> String {
    if parent == "/" {
        return format!("/{child}");
    }
    format!("{parent}/{child}")
}

fn directory_identity(meta: &FileMetadata) -> Option<(u64, u64)> {
    Some((meta.device?, meta.inode?))
}

struct Scan<'a> {
    options: &'a Options,
    matcher: &'a Regex,
    // Multiple operands or recursive walks prefix by default; -H/-h override that choice.
    filename: Option<&'a str>,
    fds: &'a FdTable,
    context: &'a Context,
    line_number: u64,
    selected: u64,
}
impl Scan<'_> {
    async fn line(&mut self, record: &[u8]) -> Result<bool, ScanError> {
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
            .await
            .map_err(write_error)?;
        }
        write(self.fds, record, self.context)
            .await
            .map_err(write_error)?;
        // grep terminates even the final unterminated selected record.
        write(self.fds, b"\n", self.context)
            .await
            .map_err(write_error)?;
        Ok(false)
    }
    async fn prefix(&self) -> Result<(), ScanError> {
        if let Some(filename) = self.filename {
            write(self.fds, filename.as_bytes(), self.context)
                .await
                .map_err(write_error)?;
            write(self.fds, b":", self.context)
                .await
                .map_err(write_error)?;
        }
        Ok(())
    }
    fn push_byte(record: &mut Vec<u8>, byte: u8, limit: usize) -> Result<(), ScanError> {
        if record.len() >= limit {
            return Err(ScanError::Other);
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
    ) -> Result<bool, ScanError> {
        for &byte in chunk {
            budget
                .checkpoint(&self.context.cancel)
                .await
                .map_err(|_| ScanError::Fatal(130))?;
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
    async fn finish_record(&mut self, record: &[u8]) -> Result<(), ScanError> {
        if !record.is_empty() {
            self.line(record).await?;
        }
        Ok(())
    }
    async fn input(&mut self, input: Endpoint) -> Result<(), ScanError> {
        let mut chunk = [0; 8192];
        let mut record = Vec::new();
        let mut budget = Budget::default();
        let limit = self.context.line_bytes.min(RECORD_BYTES);
        loop {
            budget
                .checkpoint(&self.context.cancel)
                .await
                .map_err(|_| ScanError::Fatal(130))?;
            let count = input
                .read_cancelled(&mut chunk, &self.context.cancel)
                .await
                .map_err(scan_io_error)?;
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
            .await
            .map_err(write_error)?;
        }
        Ok(())
    }
}

async fn stat_path(
    path: &str,
    follow_symlinks: bool,
    context: &Context,
) -> Result<FileMetadata, IoError> {
    context
        .cancel
        .run(context.fs().stat(path, follow_symlinks))
        .await
        .map_err(|_| IoError::Cancelled)?
}

async fn open_fs_path(path: &str, fds: &FdTable, context: &Context) -> Result<Endpoint, ScanError> {
    if descriptor_number(path).is_none()
        && let Ok(meta) = stat_path(path, true, context).await
        && meta.kind == FileKind::Directory
    {
        return Err(ScanError::IsDirectory);
    }
    let options = OpenOptions::default();
    let opening = open_path(path, fds, &options).map_err(scan_io_error)?;
    context
        .cancel
        .run(opening.open(context.fs(), &options))
        .await
        .map_err(|_| ScanError::Fatal(130))?
        .map_err(scan_io_error)
}

async fn open_input(
    file: &str,
    cwd: &str,
    fds: &FdTable,
    context: &Context,
) -> Result<Endpoint, ScanError> {
    if file == "-" {
        return endpoint(fds, 0).map_err(|_| ScanError::Other);
    }
    let path = absolute(cwd, file);
    open_fs_path(&path, fds, context).await
}

async fn list_directory_names(
    path: &str,
    budget: &mut Budget,
    context: &Context,
) -> Result<Vec<String>, ScanError> {
    let dir = context
        .cancel
        .run(context.fs().open_dir(path))
        .await
        .map_err(|_| ScanError::Fatal(130))?
        .map_err(scan_io_error)?;
    let mut names = Vec::new();
    let mut buffer = vec![0u8; MAX_PATH_BYTES + 24];
    let mut cookie = 0u64;
    loop {
        budget
            .checkpoint(&context.cancel)
            .await
            .map_err(|_| ScanError::Fatal(130))?;
        let entry = context
            .cancel
            .run(dir.read_entry(cookie, &mut buffer))
            .await
            .map_err(|_| ScanError::Fatal(130))?
            .map_err(scan_io_error)?;
        let Some(entry) = entry else {
            break;
        };
        cookie = entry.next_cookie;
        let name = std::str::from_utf8(&buffer[entry.name]).map_err(|_| ScanError::Other)?;
        if name != "." && name != ".." {
            names.push(name.to_owned());
        }
    }
    names.sort();
    Ok(names)
}

struct WalkFrame {
    display: String,
    abs: String,
    entries: Vec<String>,
    next_index: usize,
    identity: Option<(u64, u64)>,
}

struct Runner<'a> {
    options: &'a Options,
    matcher: &'a Regex,
    cwd: &'a str,
    fds: &'a FdTable,
    context: &'a Context,
    multi_operand: bool,
    found: bool,
    failed: bool,
    budget: Budget,
}

impl Runner<'_> {
    async fn scan_file(
        &mut self,
        display: &str,
        open_abs: Option<&str>,
        from_dir: bool,
    ) -> Result<bool, i32> {
        let show_filename = self
            .options
            .filename
            .unwrap_or(self.multi_operand || from_dir);
        let input = match open_abs {
            Some(abs) => open_fs_path(abs, self.fds, self.context).await,
            None => open_input(display, self.cwd, self.fds, self.context).await,
        };
        let label = if open_abs.is_none() && display == "-" {
            "(standard input)"
        } else {
            display
        };
        let mut scan = Scan {
            options: self.options,
            matcher: self.matcher,
            filename: show_filename.then_some(label),
            fds: self.fds,
            context: self.context,
            line_number: 0,
            selected: 0,
        };
        let result = match input {
            Ok(input) => scan.input(input).await,
            Err(error) => Err(error),
        };
        match result {
            Err(ScanError::Fatal(code)) => return Err(code),
            Err(ScanError::IsDirectory) => {
                self.failed = true;
                diagnostic(
                    self.fds,
                    self.context,
                    &format!("{display}: Is a directory"),
                )
                .await?;
            }
            Err(ScanError::Other) => {
                self.failed = true;
                diagnostic(
                    self.fds,
                    self.context,
                    &format!("{display}: read, output or record limit error"),
                )
                .await?;
            }
            Ok(()) => {}
        }
        self.found |= scan.selected > 0;
        Ok(self.options.quiet && self.found)
    }

    async fn report_scan_error(&mut self, display: &str, error: ScanError) -> Result<(), i32> {
        match error {
            ScanError::Fatal(code) => Err(code),
            ScanError::IsDirectory => {
                self.failed = true;
                diagnostic(
                    self.fds,
                    self.context,
                    &format!("{display}: Is a directory"),
                )
                .await
            }
            ScanError::Other => {
                self.failed = true;
                diagnostic(
                    self.fds,
                    self.context,
                    &format!("{display}: read, output or record limit error"),
                )
                .await
            }
        }
    }

    async fn resolve_child_kind(
        &mut self,
        child_abs: &str,
        child_display: &str,
    ) -> Result<Option<FileMetadata>, i32> {
        let meta = match stat_path(child_abs, false, self.context).await {
            Ok(meta) => meta,
            Err(IoError::Cancelled) => return Err(130),
            Err(error) => {
                self.report_scan_error(child_display, scan_io_error(error))
                    .await?;
                return Ok(None);
            }
        };
        if meta.kind != FileKind::Symlink {
            return Ok(Some(meta));
        }
        if self.options.recursive == Recursive::FollowCommandLine {
            return Ok(None);
        }
        match stat_path(child_abs, true, self.context).await {
            Ok(target) => Ok(Some(target)),
            Err(IoError::Cancelled) => Err(130),
            Err(error) => {
                self.report_scan_error(child_display, scan_io_error(error))
                    .await?;
                Ok(None)
            }
        }
    }

    async fn push_dir_frame(
        &mut self,
        stack: &mut Vec<WalkFrame>,
        display: String,
        abs: String,
        identity: Option<(u64, u64)>,
    ) -> Result<(), i32> {
        let diag_display = if display.is_empty() { "." } else { &display };
        let is_cycle = identity.is_some_and(|id| stack.iter().any(|f| f.identity == Some(id)));
        if is_cycle || stack.len() >= MAX_RECURSION_DEPTH {
            self.failed = true;
            diagnostic(
                self.fds,
                self.context,
                &format!("{diag_display}: recursive directory loop"),
            )
            .await?;
            return Ok(());
        }
        match list_directory_names(&abs, &mut self.budget, self.context).await {
            Ok(entries) => stack.push(WalkFrame {
                display,
                abs,
                entries,
                next_index: 0,
                identity,
            }),
            Err(error) => self.report_scan_error(diag_display, error).await?,
        }
        Ok(())
    }

    async fn walk_directory(
        &mut self,
        root_display: &str,
        root_abs: String,
        root_identity: Option<(u64, u64)>,
    ) -> Result<bool, i32> {
        if !root_display.is_empty()
            && is_excluded_dir(dir_basename(root_display), &self.options.exclude_dirs)
        {
            return Ok(false);
        }
        let mut stack = Vec::new();
        self.push_dir_frame(&mut stack, root_display.to_owned(), root_abs, root_identity)
            .await?;
        while let Some(frame) = stack.last_mut() {
            self.budget
                .checkpoint(&self.context.cancel)
                .await
                .map_err(|_| 130)?;
            if frame.next_index >= frame.entries.len() {
                stack.pop();
                continue;
            }
            let name = frame.entries[frame.next_index].clone();
            frame.next_index += 1;
            let child_display = join_display_path(&frame.display, &name);
            let child_abs = join_absolute_path(&frame.abs, &name);
            let Some(meta) = self.resolve_child_kind(&child_abs, &child_display).await? else {
                continue;
            };
            if meta.kind == FileKind::Directory {
                if !is_excluded_dir(&name, &self.options.exclude_dirs) {
                    self.push_dir_frame(
                        &mut stack,
                        child_display,
                        child_abs,
                        directory_identity(&meta),
                    )
                    .await?;
                }
                continue;
            }
            if self
                .scan_file(&child_display, Some(&child_abs), true)
                .await?
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    async fn process_operand(&mut self, file: &str, implicit_root: bool) -> Result<bool, i32> {
        if file != "-" && self.options.recursive != Recursive::None {
            let abs = absolute(self.cwd, file);
            if descriptor_number(&abs).is_none() {
                match stat_path(&abs, true, self.context).await {
                    Ok(meta) if meta.kind == FileKind::Directory => {
                        let root_display = if implicit_root { "" } else { file };
                        return self
                            .walk_directory(root_display, abs, directory_identity(&meta))
                            .await;
                    }
                    Err(IoError::Cancelled) => return Err(130),
                    _ => {}
                }
            }
        }
        self.scan_file(file, None, false).await
    }
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
    let implicit_root = files.is_empty() && options.recursive != Recursive::None;
    if files.is_empty() {
        let default_operand = if implicit_root { "." } else { "-" };
        files.push(default_operand.into());
    }
    let multi_operand = files.len() > 1;
    let mut runner = Runner {
        options: &options,
        matcher: &matcher,
        cwd,
        fds,
        context,
        multi_operand,
        found: false,
        failed: false,
        budget: Budget::default(),
    };
    for file in &files {
        runner
            .budget
            .checkpoint(&context.cancel)
            .await
            .map_err(|_| 130)?;
        // GNU quiet success takes priority over earlier input errors.
        if runner.process_operand(file, implicit_root).await? {
            return Ok(0);
        }
    }
    Ok(if runner.failed {
        2
    } else {
        i32::from(!runner.found)
    })
}
