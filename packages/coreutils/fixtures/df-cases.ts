export interface DfCase {
  readonly name: string;
  readonly args: readonly string[];
  readonly status: number;
  readonly metadata?: "help" | "version";
}

// File is the only selected output field. Never record owner filesystem usage or mounts.
export const dfCases: readonly DfCase[] = [
  { name: "file operand", args: ["--output=file", "input"], status: 0 },
  { name: "directory operand", args: ["--output=file", "directory"], status: 0 },
  { name: "spaces in operand", args: ["--output=file", "file with spaces"], status: 0 },
  { name: "symlink operand", args: ["--output=file", "link"], status: 0 },
  { name: "block display selection", args: ["-B", "4096", "--output=file", "input"], status: 0 },
  { name: "human display selection", args: ["-h", "--output=file", "input"], status: 0 },
  { name: "missing operand", args: ["--output=file", "missing"], status: 1 },
  { name: "broken symlink", args: ["--output=file", "broken"], status: 1 },
  { name: "invalid block size", args: ["-B", "invalid", "--output=file", "input"], status: 1 },
  { name: "zero block size", args: ["-B", "0", "--output=file", "input"], status: 1 },
  { name: "unknown field", args: ["--output=not-a-field", "input"], status: 1 },
  { name: "repeated field", args: ["--output=file,file", "input"], status: 1 },
  { name: "incompatible portability", args: ["-P", "--output=file", "input"], status: 1 },
  { name: "unknown option", args: ["--not-a-df-option", "input"], status: 1 },
  { name: "help", args: ["--help"], status: 0, metadata: "help" },
  { name: "version", args: ["--version"], status: 0, metadata: "version" },
];

export const unsupportedDfCases = [
  "Guest filesystem capacity, free and available blocks, block units, and inode capacity",
  "Guest mount enumeration, identity, filesystem type, local and remote filtering",
  "Guest execution, lazy loading, removal, and archive qualification until the ABI exists",
  "Host-wide no-operand df, --all, --sync, mount fields, and capacity output in this oracle",
] as const;
