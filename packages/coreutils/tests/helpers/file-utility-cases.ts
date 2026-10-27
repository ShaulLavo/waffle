export const fileUtilityEnvironment = { PATH: "/usr/bin:/bin", HOME: "/home/user", LC_ALL: "C" };

export const fileUtilityNames = ["touch", "rm", "cp", "mv"] as const;
export type FileTree = Record<string, number[] | null>;

export const initialTree: FileTree = {
  nested: null,
  target: null,
  source: null,
  "source/sub": null,
  "source/sub/data": [0, 255, 13, 10, 195, 169],
  input: [0, 255, 13, 10, 195, 169],
  existing: [111, 108, 100],
  "-odd": [120],
};

export const fileUtilityCases = [
  { name: "touch creates empty files in the working directory", script: "touch new nested/new" },
  { name: "touch keeps existing bytes", script: "touch input existing" },
  { name: "touch no-create leaves missing operands absent", script: "touch -c missing" },
  { name: "touch accepts an option terminator", script: "touch -- -new" },
  { name: "touch reports a missing parent", script: "touch absent/new" },
  { name: "rm removes files", script: "rm input existing" },
  { name: "rm force accepts missing files", script: "rm -f missing" },
  { name: "rm rejects directories without recursive mode", script: "rm source" },
  { name: "rm removes a nested tree", script: "rm -r source" },
  { name: "rm reports missing files but removes later operands", script: "rm missing input" },
  { name: "rm accepts an option terminator", script: "rm -- -odd" },
  { name: "cp copies binary bytes", script: "cp input copy" },
  { name: "cp overwrites bytes", script: "cp input existing" },
  { name: "cp no-clobber keeps the destination", script: "cp -n input existing" },
  { name: "cp copies into a directory", script: "cp input target" },
  { name: "cp recursively copies a tree", script: "cp -R source copied" },
  { name: "cp rejects a directory without recursive mode", script: "cp source copied" },
  { name: "cp rejects missing sources", script: "cp missing copied" },
  { name: "cp rejects copying a file onto itself", script: "cp input input" },
  { name: "cp accepts an option terminator", script: "cp -- -odd copied" },
  { name: "mv renames binary files", script: "mv input renamed" },
  { name: "mv force replaces the destination", script: "mv -f input existing" },
  { name: "mv no-clobber keeps both files", script: "mv -n input existing" },
  { name: "mv moves into a directory", script: "mv input target" },
  { name: "mv renames directories", script: "mv source renamed" },
  { name: "mv rejects missing sources", script: "mv missing renamed" },
  { name: "mv accepts an option terminator", script: "mv -- -odd renamed" },
] as const;

export const fileUtilityMetadataGap = {
  name: "mv sees synthetic destination permissions as read-only",
  script: "mv input existing",
};
