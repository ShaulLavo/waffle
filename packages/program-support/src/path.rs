//! Join guest paths without rewriting their components.

pub fn join_cwd<'a>(cwd: &str, path: &'a str) -> std::borrow::Cow<'a, str> {
    if path.starts_with('/') || path.is_empty() {
        return std::borrow::Cow::Borrowed(path);
    }
    let separator = if cwd.ends_with('/') { "" } else { "/" };
    std::borrow::Cow::Owned(format!("{cwd}{separator}{path}"))
}
