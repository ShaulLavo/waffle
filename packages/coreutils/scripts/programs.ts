export const coreutilsNames = [
  "env",
  "clear",
  "cat",
  "cut",
  "tr",
  "head",
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
] as const;

export const coreutilsPackageNames = coreutilsNames.filter(
  (name) => !["clear", "cut", "tr", "wc"].includes(name),
);

const cooperative = new Set(["cat", "mkdir", "seq", "tail"]);

export function verificationOptions(name: string) {
  return cooperative.has(name)
    ? { filesystemAdapter: "waffle_program_support::runtime::wasi" }
    : {};
}
