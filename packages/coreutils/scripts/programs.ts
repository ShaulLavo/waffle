export const coreutilsNames = [
  "env",
  "clear",
  "cat",
  "cut",
  "tr",
  "head",
  "nl",
  "which",
  "ls",
  "mkdir",
  "seq",
  "sort",
  "tail",
  "uniq",
  "wc",
  "touch",
  "rm",
  "cp",
  "mv",
  "echo",
  "date",
] as const;

export const coreutilsPackageNames = coreutilsNames.filter(
  (name) => !["clear", "cut", "tr", "wc", "echo", "date"].includes(name),
);

const cooperative = new Set(["cat", "mkdir", "seq", "tail"]);

export function verificationOptions(name: string) {
  return cooperative.has(name)
    ? { filesystemAdapter: "waffle_program_support::runtime::wasi" }
    : {};
}
