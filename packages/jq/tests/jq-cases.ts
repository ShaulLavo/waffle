export interface JqCase {
  readonly name: string;
  readonly args: readonly string[];
  readonly stdin?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly error?: {
    readonly candidateExit: number;
    readonly candidateStderr: string;
  };
}

const ghRows = JSON.stringify([
  { number: 3, state: "OPEN", title: "third" },
  { number: 1, state: "OPEN", title: "first" },
  { number: 2, state: "OPEN", title: "second" },
]);

export const jqCases: readonly JqCase[] = [
  { name: "identity compact", args: ["-c", "."], stdin: '{"b":[2,1],"a":true}' },
  { name: "raw top-level string", args: ["-r", ".full_name"], stdin: '{"full_name":"cli/cli"}' },
  { name: "raw top-level number", args: ["-r", ".number"], stdin: '{"number":231}' },
  { name: "raw top-level boolean", args: ["-r", "."], stdin: "true" },
  { name: "raw top-level null", args: ["-r", "."], stdin: "null" },
  {
    name: "raw embedded newline",
    args: ["-r", ".text"],
    stdin: '{"text":"first\\nsecond"}',
  },
  {
    name: "compact array construction",
    args: ["-c", "map({id: .number, label: .title})"],
    stdin: '[{"number":2,"title":"second"},{"number":1,"title":"first"}]',
  },
  {
    name: "compact object construction",
    args: ["-c", "{name: .full_name, count: (.items | length)}"],
    stdin: '{"full_name":"cli/cli","items":[1,2,3]}',
  },
  { name: "null input", args: ["-n", "-c", "{answer: 42, ok: true}"] },
  { name: "slurp stream", args: ["-s", "-c", "map(.id)"], stdin: '{"id":1}\n{"id":2}\n{"id":3}' },
  { name: "slurp empty input", args: ["-s", "length"], stdin: "" },
  { name: "exit status true", args: ["-e", "."], stdin: "true" },
  { name: "exit status false", args: ["-e", "."], stdin: "false" },
  { name: "exit status null", args: ["-e", "."], stdin: "null" },
  { name: "exit status no output", args: ["-e", "empty"], stdin: "null" },
  {
    name: "string argument",
    args: ["-n", "-r", "--arg", "who", "Ada Lovelace", "$who"],
  },
  {
    name: "JSON argument",
    args: ["-n", "-c", "--argjson", "value", '{"b":[2,1],"a":true}', "$value"],
  },
  {
    name: "stream inputs",
    args: ["-c", "{id, doubled: (.value * 2)}"],
    stdin: '{"id":1,"value":4}\n{"id":2,"value":5}\n',
  },
  {
    name: "map select pipes",
    args: ["-c", ".items | map(select(.active)) | map(.name)"],
    stdin:
      '{"items":[{"name":"one","active":true},{"name":"two","active":false},{"name":"three","active":true}]}',
  },
  {
    name: "gh complex query",
    args: [
      "-r",
      'map(select(.state == "OPEN" and .number > 1)) | sort_by(.number) | map(.title) | join("\n")',
    ],
    stdin: ghRows,
  },
  {
    name: "array and arithmetic construction",
    args: ["-c", "[.items[].n, (.total + 1)]"],
    stdin: '{"items":[{"n":2},{"n":3}],"total":5}',
  },
  {
    name: "nested object construction",
    args: ["-c", "{id, name, nested: {ok: true}}"],
    stdin: '{"id":7,"name":"seven"}',
  },
  {
    name: "string case operations",
    args: ["-r", 'ascii_downcase + "|" + ascii_upcase'],
    stdin: '"Hello World"',
  },
  {
    name: "string trim operations",
    args: ["-r", 'ltrimstr("pre") | rtrimstr("post")'],
    stdin: '"pre-content-post"',
  },
  {
    name: "string boundary operations",
    args: ["-c", '[startswith("ab"), endswith("yz")]'],
    stdin: '"abcdefwxyz"',
  },
  {
    name: "split map join",
    args: ["-r", 'split(",") | map(ascii_upcase) | join(";")'],
    stdin: '"one,two,three"',
  },
  {
    name: "regular expression substitution",
    args: ["-r", 'gsub("[0-9]+"; "#")'],
    stdin: '"a12b345c"',
  },
  {
    name: "regular expression capture",
    args: ["-c", 'capture("(?<word>[a-z]+)")'],
    stdin: '"123 hello 456"',
  },
  { name: "string conversions", args: ["-c", "[tostring, (tonumber + 1)]"], stdin: '"41"' },
  { name: "Unicode lengths", args: ["-c", "[length, utf8bytelength]"], stdin: '"שלום🌍"' },
  {
    name: "environment filter",
    args: ["-n", "-r", "env.JQ_ORACLE_VALUE"],
    env: { JQ_ORACLE_VALUE: "from environment" },
  },
  {
    name: "environment variable",
    args: ["-n", "-r", "$ENV.JQ_ORACLE_VALUE"],
    env: { JQ_ORACLE_VALUE: "from environment" },
  },
  {
    name: "named arguments object",
    args: ["-n", "-c", "--arg", "x", "a value", "$ARGS.named"],
  },
  {
    name: "positional arguments object",
    args: ["-n", "-c", "--args", "$ARGS.positional", "one", "two words"],
  },
  {
    name: "recursive definition",
    args: ["-n", "def fact: if . <= 1 then 1 else . * ((. - 1) | fact) end; 6 | fact"],
  },
  { name: "reduce", args: ["-c", "reduce .[] as $x (0; . + $x)"], stdin: "[1,2,3,4]" },
  {
    name: "destructured variables",
    args: ["-c", ". as {$a, $b} | $a + $b"],
    stdin: '{"a":20,"b":22}',
  },
  {
    name: "scalar paths",
    args: ["-c", "[paths(scalars)]"],
    stdin: '{"a":[1,{"b":true}],"c":null}',
  },
  {
    name: "invalid expression",
    args: [".["],
    stdin: "null",
    error: { candidateExit: 3, candidateStderr: "unexpected" },
  },
  {
    name: "unknown filter",
    args: ["definitely_not_a_filter"],
    stdin: "null",
    error: { candidateExit: 3, candidateStderr: "definitely_not_a_filter" },
  },
  {
    name: "invalid JSON argument",
    args: ["-n", "--argjson", "value", "{", "$value"],
    error: { candidateExit: 5, candidateStderr: "--argjson value" },
  },
  {
    name: "runtime type error",
    args: [".foo"],
    stdin: "1",
    error: { candidateExit: 5, candidateStderr: 'cannot index 1 with "foo"' },
  },
  {
    name: "invalid JSON input",
    args: ["."],
    stdin: "{",
    error: { candidateExit: 5, candidateStderr: "parse" },
  },
];
