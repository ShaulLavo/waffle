export interface DateCase {
  readonly name: string;
  readonly args: readonly string[];
  readonly status: number;
  readonly input?: string;
  readonly tz?: string;
  readonly kind?: "metadata" | "unsupported";
}

export const fixedTime = {
  nanoseconds: 1709210096123456789n,
  epoch: "@1709210096.123456789",
} as const;

export const dateCases: readonly DateCase[] = [
  { name: "epoch zero UTC", args: ["-u", "-d", "@0"], status: 0 },
  { name: "negative epoch", args: ["-u", "-d", "@-1", "+%s %FT%TZ"], status: 0 },
  { name: "negative fractional epoch", args: ["-u", "-d", "@-1.5", "+%s.%N"], status: 0 },
  { name: "nanoseconds", args: ["--utc", "--date", fixedTime.epoch, "+%s %N"], status: 0 },
  {
    name: "survey timestamp format",
    args: ["-u", "-d", fixedTime.epoch, "+%Y%m%d-%H%M%S"],
    status: 0,
  },
  { name: "ISO date", args: ["-u", "-d", fixedTime.epoch, "-I"], status: 0 },
  { name: "ISO seconds attached", args: ["-u", "-d", fixedTime.epoch, "-Iseconds"], status: 0 },
  {
    name: "ISO long nanoseconds",
    args: ["--utc", "-d", fixedTime.epoch, "--iso-8601=ns"],
    status: 0,
  },
  { name: "ISO hours", args: ["-u", "-d", fixedTime.epoch, "--iso-8601=hours"], status: 0 },
  { name: "ISO minutes", args: ["-u", "-d", fixedTime.epoch, "--iso-8601=minutes"], status: 0 },
  { name: "RFC email", args: ["-u", "-d", fixedTime.epoch, "-R"], status: 0 },
  { name: "RFC 3339", args: ["-u", "-d", fixedTime.epoch, "--rfc-3339=seconds"], status: 0 },
  {
    name: "calendar and week",
    args: ["-u", "-d", "2024-02-29 12:34:56 UTC", "+%F %T %j %u %G-W%V"],
    status: 0,
  },
  { name: "English names", args: ["-u", "-d", fixedTime.epoch, "+%a %A %b %B"], status: 0 },
  {
    name: "padding and escapes",
    args: ["-u", "-d", "2024-02-03 UTC", "+%-d|%_d|%0d|%%|%n|%t"],
    status: 0,
  },
  { name: "empty format", args: ["-u", "-d", "@0", "+"], status: 0 },
  {
    name: "explicit offset",
    args: ["-u", "-d", "2024-02-29 12:34:56 +0530", "+%F %T %z"],
    status: 0,
  },
  { name: "fixed POSIX TZ", args: ["-d", fixedTime.epoch, "+%F %T %z"], tz: "EST5", status: 0 },
  {
    name: "UTC overrides TZ",
    args: ["-u", "-d", fixedTime.epoch, "+%F %T %z"],
    tz: "EST5",
    status: 0,
  },
  {
    name: "absolute relative arithmetic",
    args: ["-u", "-d", "2024-02-29 12:34:56 UTC +1 day", "+%F %T"],
    status: 0,
  },
  { name: "file reference relative cwd", args: ["-u", "-r", "reference", "+%s %F %T"], status: 0 },
  {
    name: "file reference long",
    args: ["--utc", "--reference=reference", "--iso-8601=seconds"],
    status: 0,
  },
  { name: "date file", args: ["-u", "-f", "dates", "+%F"], status: 0 },
  { name: "date stdin", args: ["-u", "-f", "-", "+%s"], input: "@0\n@1\n", status: 0 },
  { name: "invalid date", args: ["-u", "-d", "not-a-date"], status: 1 },
  { name: "invalid calendar date", args: ["-u", "-d", "2023-02-29"], status: 1 },
  { name: "missing reference", args: ["-u", "-r", "missing"], status: 1 },
  { name: "missing date argument", args: ["-d"], status: 1 },
  { name: "invalid ISO precision", args: ["-Ibogus"], status: 1 },
  { name: "lexical survey artifact is not a flag", args: ["-c"], status: 1 },
  { name: "incompatible sources", args: ["-d", "@0", "-r", "reference"], status: 1 },
  { name: "extra operand", args: ["-d", "@0", "+%s", "extra"], status: 1 },
  { name: "format missing plus", args: ["-d", "@0", "%s"], status: 1 },
  { name: "multiple formats", args: ["-u", "-d", "@0", "-I", "+%s"], status: 1 },
  { name: "clock setting rejected", args: ["-s", "@0"], status: 1, kind: "unsupported" },
  { name: "abbreviated clock setting rejected", args: ["--se=@0"], status: 1, kind: "unsupported" },
  { name: "help", args: ["--help"], status: 0, kind: "metadata" },
  { name: "version", args: ["--version"], status: 0, kind: "metadata" },
];

export const currentDateCases = [
  { name: "current epoch", args: ["-u", "+%s %N"] },
  { name: "current ISO seconds", args: ["-u", "-Iseconds"] },
  { name: "current default", args: ["--utc"] },
] as const;
