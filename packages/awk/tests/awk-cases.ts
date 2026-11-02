export interface AwkCase {
  readonly name: string;
  readonly args: readonly string[];
  readonly stdin?: string;
  readonly files?: Readonly<Record<string, string>>;
  readonly outputFiles?: readonly string[];
  readonly cwd?: string;
}

export const awkCases: readonly AwkCase[] = [
  {
    name: "exit from nested BEGIN expression",
    args: ['function stop() { exit 9 } BEGIN { print stop()+3 } END {print "end"}'],
  },
  {
    name: "exit from nested input expression",
    args: ['function stop() { exit 7 } { print stop()+3 } END {print "end",NR}'],
    stdin: "first\nsecond\n",
  },
  {
    name: "exit from nested END expression",
    args: ['function stop() { exit 11 } END { print stop()+3; print "unreachable" }'],
    stdin: "first\n",
  },
  { name: "END exit replaces BEGIN exit", args: ['BEGIN {exit 4} END {print "end";exit 5}'] },
  { name: "field selection", args: ["{print $2}"], stdin: "alpha 10\nbeta 20\n" },
  { name: "last field and field count", args: ["{print NF, $NF}"], stdin: "a b c\nx\n\n" },
  {
    name: "FS and OFS",
    args: ["-F,", "-v", "OFS=|", "{print $2, $1}"],
    stdin: "alpha,10\nbeta,20\n",
  },
  { name: "separate -F argument", args: ["-F", ":", "{print $1, $3}"], stdin: "a:b:c\nd:e:f\n" },
  {
    name: "BEGIN END arithmetic",
    args: ['BEGIN { print "start" } { sum += $2 } END { print NR, sum }'],
    stdin: "a 10\nb 20\n",
  },
  {
    name: "regex pattern",
    args: ["/error/ { print toupper($1) }"],
    stdin: "ok 1\nerror 2\nERROR 3\n",
  },
  {
    name: "numeric pattern",
    args: ['$2 >= 10 && $1 != "skip" {print $1}'],
    stdin: "a 9\nb 10\nskip 20\n",
  },
  {
    name: "range pattern",
    args: ["/start/,/stop/"],
    stdin: "before\nstart\nmiddle\nstop\nafter\n",
  },
  { name: "printf", args: ['{ printf "%s=%.2f\\n", $1, $2 * 1.5 }'], stdin: "alpha 2\nbeta 3\n" },
  {
    name: "sprintf and numeric conversion",
    args: ['BEGIN { print sprintf("%04d", "12" + 3), int(3.9), 2^3 }'],
  },
  {
    name: "associative array counts",
    args: ['{ count[$1]++ } END { print count["apple"], count["pear"], ("apple" in count) }'],
    stdin: "apple\npear\napple\n",
  },
  {
    name: "array delete and iteration",
    args: ['BEGIN { a["x"]=1; a["y"]=2; delete a["x"]; for (k in a) print k, a[k] }'],
  },
  { name: "multi-index arrays", args: ['BEGIN { a["x",2]=7; print a["x",2], (("x",2) in a) }'] },
  { name: "gsub regex", args: ['{ gsub(/[0-9]+/, "#"); print }'], stdin: "a12b345c\n" },
  {
    name: "sub return and target",
    args: ['{ n=sub(/a/, "&X", $1); print n, $0 }'],
    stdin: "banana other\nnone other\n",
  },
  {
    name: "match position",
    args: ["{ print match($0, /[0-9]+/), RSTART, RLENGTH }"],
    stdin: "ab123cd\nnone\n",
  },
  {
    name: "split and string operations",
    args: [
      'BEGIN { n=split("a:b:c", a, ":"); print n, a[2], substr("hello",2,3), index("hello","ll") }',
    ],
  },
  {
    name: "UTF-8 strings",
    args: ['BEGIN { s="hé世界"; print length(s), substr(s,2,2), index(s,"世") }'],
  },
  {
    name: "regex field separator",
    args: ['BEGIN { FS="[,:]+"; OFS="/" } {print $1,$2,$3}'],
    stdin: "a,,b:c\n",
  },
  { name: "record separator", args: ['BEGIN { RS=":"; ORS="|" } {print NR, $0}'], stdin: "a:b:c" },
  {
    name: "field rebuild",
    args: ['BEGIN { OFS=":" } { $2="changed"; print $0 }'],
    stdin: "a b c\n",
  },
  {
    name: "multi-file iteration",
    args: ["{ print FNR, NR, FILENAME, $1 }", "one.txt", "two.txt"],
    cwd: "/awk-work",
    files: { "one.txt": "one\none-b\n", "two.txt": "two\n" },
  },
  {
    name: "nextfile",
    args: ["{print FILENAME, $0; nextfile}", "one.txt", "two.txt"],
    cwd: "/awk-work",
    files: { "one.txt": "first\nignored\n", "two.txt": "second\nignored\n" },
  },
  {
    name: "-v and exit status",
    args: ["-v", "limit=3", '$1 > limit { print $1; exit 7 } END {print "end"}'],
    stdin: "1\n4\n",
  },
  {
    name: "command-line assignments",
    args: ["{print label,$0}", "label=before", "one.txt", "label=after", "two.txt"],
    files: { "one.txt": "one\n", "two.txt": "two\n" },
  },
  {
    name: "-f script",
    args: ["-f", "script.awk", "data.txt"],
    cwd: "/awk-work",
    files: { "script.awk": '{print $1 ":" $NF}\n', "data.txt": "a b c\nd e f\n" },
  },
  {
    name: "argv and environment",
    args: ['BEGIN { print ARGC,ARGV[0],ARGV[1],ENVIRON["AWK_FIXTURE"] }', "one", "two"],
  },
  {
    name: "function and recursion",
    args: ["function fact(n) { return n <= 1 ? 1 : n * fact(n-1) } BEGIN {print fact(6)}"],
  },
  {
    name: "loops next break continue",
    args: [
      "BEGIN { for(i=1;i<=5;i++) { if(i==2) continue; if(i==5) break; sum+=i } print sum } NR==1 {next} {print $0}",
    ],
    stdin: "skip\nkeep\n",
  },
  {
    name: "getline file",
    args: ['BEGIN { while ((getline x < "data") > 0) print toupper(x); print close("data") }'],
    files: { data: "one\ntwo\n" },
  },
  {
    name: "file redirection",
    args: [
      'BEGIN { print "first" > "output"; close("output"); print "second" >> "output"; close("output") }',
    ],
    outputFiles: ["output"],
  },
  {
    name: "CSV upstream extension",
    args: ["--csv", "{print NF, $1, $2}"],
    stdin: '"one,two",three\n',
  },
  { name: "explicit stdin argument", args: ["{print NR,$0}", "-"], stdin: "one\ntwo" },
  { name: "version", args: ["--version"] },
  { name: "missing input", args: ["{print}", "absent-input"] },
  { name: "invalid -v", args: ["-v", "not-an-assignment", "BEGIN {print 1}"] },
  { name: "invalid program", args: ["{ print $1"], stdin: "value\n" },
  { name: "division by zero", args: ["BEGIN { print 1/0 }"] },
  { name: "negative field", args: ["{print $(-1)}"], stdin: "value\n" },
];

export const unsupportedCases = [
  { name: "system", program: 'BEGIN { system("printf no") }', diagnostic: "system is unavailable" },
  {
    name: "input command pipe",
    program: 'BEGIN { "printf no" | getline value }',
    diagnostic: "command pipes are unavailable",
  },
  {
    name: "output command pipe",
    program: 'BEGIN { print "no" | "cat" }',
    diagnostic: "command pipes are unavailable",
  },
];
