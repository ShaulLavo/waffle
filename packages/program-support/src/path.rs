//! Lexical absolute paths shared by guests; no shell variable or alias state.
pub fn absolute(cwd: &str, path: &str) -> String {
    let path = if path.starts_with('/') {
        path.to_owned()
    } else {
        format!("{cwd}/{path}")
    };
    let mut components = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                components.pop();
            }
            _ => components.push(part),
        }
    }
    format!("/{}", components.join("/"))
}

#[cfg(test)]
mod tests {
    use super::absolute;

    #[test]
    fn resolves_relative_and_parent_components() {
        assert_eq!(absolute("/work", "./a/../b"), "/work/b");
        assert_eq!(absolute("/work", "/tmp/x"), "/tmp/x");
    }
}
pub fn join_cwd<'a>(cwd: &str, path: &'a str) -> std::borrow::Cow<'a, str> {
    if path.starts_with('/') || path.is_empty() {
        return std::borrow::Cow::Borrowed(path);
    }
    let separator = if cwd.ends_with('/') { "" } else { "/" };
    std::borrow::Cow::Owned(format!("{cwd}{separator}{path}"))
}
