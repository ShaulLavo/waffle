//! Neutral guest-side support for separately linked Waffle programs.
//! This crate contains no shell parser, interpreter, session or process host.
pub mod executor;
pub mod io;
pub mod path;
pub mod runtime;

/// Independent utility record bound, previously supplied by the shell interpreter.
pub const DEFAULT_LINE_BYTES: usize = 64 * 1024;
