export const checksumNames = [
  "b2sum",
  "cksum",
  "md5sum",
  "sha1sum",
  "sha224sum",
  "sha256sum",
  "sha384sum",
  "sha512sum",
  "sum",
] as const;

export type ChecksumName = (typeof checksumNames)[number];

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
  ...checksumNames,
] as const;

const separatelyBuilt: readonly string[] = ["clear", "cut", "tr", "wc", "echo", "date"];

export const coreutilsPackageNames = coreutilsNames.filter(
  (name) => !separatelyBuilt.concat(checksumNames).includes(name),
);

const cooperative = new Set(["cat", "mkdir", "seq", "tail"]);

export function verificationOptions(name: string) {
  return cooperative.has(name)
    ? { filesystemAdapter: "waffle_program_support::runtime::wasi" }
    : {};
}
