pub fn join_cwd(cwd: &str, path: &str) -> String {
    if path.is_empty() || path.starts_with('/') {
        return path.to_owned();
    }
    format!("{}/{path}", cwd.trim_end_matches('/'))
}

#[cfg(test)]
mod tests {
    use super::join_cwd;

    #[test]
    fn joins_without_altering_operands() {
        assert_eq!(join_cwd("/work", "./a/../b/"), "/work/./a/../b/");
        assert_eq!(join_cwd("/work", "/tmp//x"), "/tmp//x");
        assert_eq!(join_cwd("/", "file"), "/file");
        assert_eq!(join_cwd("/work", ""), "");
    }
}
