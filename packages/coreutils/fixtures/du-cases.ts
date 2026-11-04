export interface DuCase {
  readonly name: string;
  readonly args: readonly string[];
  readonly status: number;
}

// File-only apparent sizes avoid claiming that native directory st_size is portable.
export const duCases: readonly DuCase[] = [
  { name: "file bytes", args: ["-b", "tree/a"], status: 0 },
  { name: "empty bytes", args: ["-b", "tree/empty"], status: 0 },
  { name: "sparse apparent bytes", args: ["-b", "sparse"], status: 0 },
  { name: "sparse allocated bytes", args: ["-B1", "sparse"], status: 0 },
  { name: "apparent kilobytes", args: ["--apparent-size", "-k", "tree/sub/b"], status: 0 },
  { name: "apparent block rounding", args: ["--apparent-size", "-B2", "tree/a"], status: 0 },
  { name: "binary human size", args: ["--apparent-size", "-h", "tree/sub/b"], status: 0 },
  { name: "decimal human size", args: ["--apparent-size", "--si", "tree/sub/b"], status: 0 },
  { name: "file grand total", args: ["-bc", "tree/a", "tree/sub/b"], status: 0 },
  { name: "NUL file output", args: ["-b0", "tree/a", "tree/empty"], status: 0 },
  { name: "space in name", args: ["-b", "tree/space name"], status: 0 },
  { name: "Unicode in name", args: ["-b", "tree/שלום"], status: 0 },
  { name: "dash operand", args: ["-b", "--", "-operand"], status: 0 },
  { name: "allocated directory total", args: ["-s", "tree"], status: 0 },
  { name: "allocated depth zero", args: ["--max-depth=0", "tree"], status: 0 },
  { name: "allocated directory rows", args: ["tree"], status: 0 },
  { name: "allocated all rows", args: ["-a", "tree"], status: 0 },
  { name: "exclude subtree", args: ["-s", "--exclude=sub", "tree"], status: 0 },
  { name: "separate directories", args: ["-S", "tree"], status: 0 },
  { name: "inode summary", args: ["--inodes", "-s", "tree"], status: 0 },
  { name: "hardlink deduplication", args: ["-bc", "tree/a", "hard"], status: 0 },
  { name: "hardlink counting", args: ["-blc", "tree/a", "hard"], status: 0 },
  { name: "symlink apparent bytes", args: ["-b", "link"], status: 0 },
  { name: "follow argument link", args: ["-bH", "link"], status: 0 },
  { name: "follow every link", args: ["-bL", "link"], status: 0 },
  { name: "missing operand", args: ["-b", "missing"], status: 1 },
  { name: "invalid depth", args: ["--max-depth=no", "tree"], status: 1 },
  { name: "conflicting depth", args: ["-s", "--max-depth=1", "tree"], status: 1 },
];
