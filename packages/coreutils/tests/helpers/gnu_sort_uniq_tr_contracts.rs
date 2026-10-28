use std::{
    collections::HashSet,
    fs,
    io::{ErrorKind, Write},
    path::PathBuf,
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

const CORPUS: &str = include_str!("../../fixtures/gnu-sort-uniq-tr-contracts/corpus.tsv");

struct Scratch(PathBuf);

impl Scratch {
    fn new(program: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "waffle-gnu-sort-uniq-tr-{program}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).expect("remove GNU usage contract scratch");
    }
}

fn bytes(hex: &str) -> Vec<u8> {
    if hex == "-" {
        return Vec::new();
    }
    assert!(hex.is_ascii() && hex.len().is_multiple_of(2));
    (0..hex.len())
        .step_by(2)
        .map(|offset| u8::from_str_radix(&hex[offset..offset + 2], 16).unwrap())
        .collect()
}

fn check_case(binary: &str, row: &[&str], scratch: &Scratch) {
    let name = row[0];
    let args: Vec<String> = row[2]
        .split(':')
        .filter(|arg| !arg.is_empty())
        .map(|arg| String::from_utf8(bytes(arg)).unwrap())
        .collect();
    let input = bytes(row[4]);
    assert_eq!(bytes(row[5]).len(), 32, "{name}: recorded SHA-256 length");
    fs::write(scratch.0.join("input"), &input).unwrap();
    let mut child = Command::new(binary)
        .args(args)
        .current_dir(&scratch.0)
        .env_clear()
        .env("LC_ALL", "C")
        .env("TZ", "UTC")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let write_result = match row[3] {
        "stdin-pipe" => stdin.write_all(&input),
        "file-operand" => Ok(()),
        mode => panic!("{name}: unknown input mode {mode}"),
    };
    drop(stdin);
    let output = child.wait_with_output().unwrap();
    if let Err(error) = write_result {
        assert_eq!(error.kind(), ErrorKind::BrokenPipe, "{name}: stdin");
    }
    assert_eq!(
        output.status.code(),
        Some(row[6].parse().unwrap()),
        "{name}: status"
    );
    assert_eq!(output.stdout, bytes(row[7]), "{name}: stdout");
    assert_eq!(output.stderr, bytes(row[8]), "{name}: stderr");
}

pub fn assert_contracts(binary: &str, program: &str, expected_count: usize) {
    let scratch = Scratch::new(program);
    let mut names = HashSet::new();
    let mut count = 0;
    for line in CORPUS.lines().filter(|line| !line.starts_with('#')) {
        let row: Vec<&str> = line.split('\t').collect();
        assert_eq!(row.len(), 9, "corpus row columns: {line}");
        assert!(names.insert(row[0]), "duplicate corpus name: {}", row[0]);
        if row[1] != program {
            continue;
        }
        check_case(binary, &row, &scratch);
        count += 1;
    }
    assert_eq!(count, expected_count, "{program}: corpus case count");
    assert_eq!(names.len(), 28, "complete corpus case count");
}
