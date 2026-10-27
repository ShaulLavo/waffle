export const rgFiles: Readonly<Record<string, string>> = {
  ".git/HEAD": "ref: refs/heads/main\n",
  ".gitignore": "ignored.txt\nignored-dir/\n",
  ".ignore": "private.txt\n",
  ".hidden": "needle hidden\n",
  "ignored.txt": "needle ignored\n",
  "ignored-dir/file.txt": "needle ignored directory\n",
  "private.txt": "needle private\n",
  "src/alpha.txt": "needle\nhaystack\nNeedle42\nneedle two\n",
  "src/beta.rs": 'let value = "needle";\n',
};

export const rgCases = [
  {
    name: "recursive ignore rules",
    args: ["--sort", "path", "-n", "needle", "."],
    stdin: "",
    stdout:
      './src/alpha.txt:1:needle\n./src/alpha.txt:4:needle two\n./src/beta.rs:1:let value = "needle";\n',
    status: 0,
    error: "",
  },
  {
    name: "hidden files are opt-in",
    args: ["--hidden", "--sort", "path", "-l", "needle", "."],
    stdin: "",
    stdout: "./.hidden\n./src/alpha.txt\n./src/beta.rs\n",
    status: 0,
    error: "",
  },
  {
    name: "ignore rules can be disabled",
    args: ["--no-ignore", "--sort", "path", "-l", "needle", "."],
    stdin: "",
    stdout:
      "./ignored-dir/file.txt\n./ignored.txt\n./private.txt\n./src/alpha.txt\n./src/beta.rs\n",
    status: 0,
    error: "",
  },
  {
    name: "regex alternatives and line numbers",
    args: ["-n", "-e", "^needle", "-e", "Needle[0-9]+", "src/alpha.txt"],
    stdin: "",
    stdout: "1:needle\n3:Needle42\n4:needle two\n",
    status: 0,
    error: "",
  },
  {
    name: "fixed strings and case folding",
    args: ["-F", "-i", "-c", "needle", "src/alpha.txt"],
    stdin: "",
    stdout: "3\n",
    status: 0,
    error: "",
  },
  {
    name: "file globs",
    args: ["--sort", "path", "-g", "*.rs", "-l", "needle", "."],
    stdin: "",
    stdout: "./src/beta.rs\n",
    status: 0,
    error: "",
  },
  {
    name: "implicit piped stdin",
    args: ["needle"],
    stdin: "other\nneedle\n",
    stdout: "needle\n",
    status: 0,
    error: "",
  },
  {
    name: "explicit stdin",
    args: ["-n", "needle", "-"],
    stdin: "other\nneedle\n",
    stdout: "2:needle\n",
    status: 0,
    error: "",
  },
  {
    name: "no match",
    args: ["absent", "src/alpha.txt"],
    stdin: "",
    stdout: "",
    status: 1,
    error: "",
  },
  {
    name: "invalid regex",
    args: ["[", "src/alpha.txt"],
    stdin: "",
    stdout: "",
    status: 2,
    error: "unclosed character class",
  },
  {
    name: "missing file",
    args: ["needle", "missing"],
    stdin: "",
    stdout: "",
    status: 2,
    error: "missing",
  },
] as const;

export const rgUnsupported = [
  { args: ["--threads", "2"], error: "WASI supports only one search thread" },
  { args: ["--mmap"], error: "WASI does not support --mmap" },
  { args: ["--pre", "cat"], error: "WASI does not support --pre" },
  { args: ["--search-zip"], error: "WASI does not support --search-zip" },
  { args: ["--hostname-bin", "hostname"], error: "WASI does not support --hostname-bin" },
  { args: ["--pcre2"], error: "PCRE2 is not available" },
] as const;

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
