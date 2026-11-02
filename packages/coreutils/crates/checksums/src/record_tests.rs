use super::{LineFormat, LineInfo};
use std::ffi::OsStr;

#[test]
fn escaped_records_decode_the_filename_once() {
    for line in [
        r"\abcdef  back\\slash",
        r"\abcdef *back\\slash",
        r"\abcdef back\\slash",
        r"\SHA256 (back\\slash) = abcdef",
    ] {
        let info = LineInfo::parse(OsStr::new(line), &mut None, false).unwrap();
        assert_eq!(info.filename, br"back\slash");
        assert_eq!(info.checksum, "abcdef");
    }
    let info =
        LineInfo::parse(OsStr::new(r"\abcdef  literal\\newline\n"), &mut None, false).unwrap();
    assert_eq!(info.filename, b"literal\\newline\n");
}

#[test]
fn unmarked_records_preserve_literal_backslashes() {
    for line in [
        r"abcdef  literal\name",
        r"abcdef *literal\name",
        r"abcdef literal\name",
        r"SHA256 (literal\name) = abcdef",
    ] {
        let info = LineInfo::parse(OsStr::new(line), &mut None, false).unwrap();
        assert_eq!(info.filename, br"literal\name");
    }
}

#[test]
fn escaped_and_plain_records_share_the_cached_format() {
    let mut format = None;
    for line in [r"\abcdef  back\\slash", "abcdef  plain"] {
        let info = LineInfo::parse(OsStr::new(line), &mut format, false).unwrap();
        assert_eq!(info.format, LineFormat::Untagged);
        assert_eq!(format, Some(LineFormat::Untagged));
    }
}
