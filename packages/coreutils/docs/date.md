# date

The date leaf displays calendar dates, Unix timestamps, and file modification times through the pinned uutils implementation. It is a separate WASI guest in the coreutils family, not a host command or a new date parser.

```sh
date -u -d @0 +%FT%TZ
date --utc --iso-8601=seconds
date -u -r source.txt +%s
```

## Qualified behavior

The bounded GNU comparison covers `-u` and `--utc`, `-I` and `--iso-8601` at date, hour, minute, second, and nanosecond precision. It also covers `-d` and `--date`, custom `+FORMAT` output, negative and fractional epoch timestamps, calendar dates, explicit numeric timezone offsets, POSIX `TZ`, and leap-day arithmetic from an explicit date.

`-r` and `--reference` use actual file modification times. Relative file operands use the caller's `PWD`, initialized through the existing family WASI cwd helper. The caller must keep `PWD` aligned with its requested working directory. `-f` reads explicit dates from a file or standard input. Invalid dates, missing files, malformed options, extra operands, and conflicting sources return nonzero status.

Without `-d`, `-r`, or `-f`, date reads the runtime's real wall clock. The runtime test checks that its epoch result falls between the real timestamps immediately before and after execution. No production clock or file metadata is substituted.

## Limits

Clock setting is always rejected, including `-s`, `--set`, and accepted abbreviations. The original adapter checks the parsed upstream option before execution on every target, so native verification cannot set the host clock either. The survey's high `-s`, `-n`, `-c`, `-e`, and `-o` counts include letters split from other arguments. They are not a request to add new date options.

The package follows the family's English-only locale policy. Qualification sets `LC_ALL=C`, `LANG=C`, and an explicit `TZ`. Use `-u` or an explicit supported timezone rather than assuming that a browser exposes its operating system timezone. Non-English formatting and the rest of GNU's date-string grammar are outside this unit's claim. Help, version, and diagnostic wording remain uutils, not GNU.

## Source and verification

The implementation is unchanged `uu_date` 0.13.0 at uutils revision `07763857f6b9a547742a994b58aef0ccd036198b`. [The source receipt](../provenance/date.source.json) records source hashes, the retained MIT notice, optional date-localization feature selection, and the original adapter. An isolated `waffle-date` crate prevents date from compiling unrelated family guests. It uses the existing family producer, selected English catalog generator, patched libc verifier, 256 MiB memory cap, and name-section stripping.

After the root workspace and family integration rows are applied, build only date:

```sh
node packages/coreutils/scripts/build-date.ts
node --disable-warning=ExperimentalWarning --test packages/coreutils/scripts/date-source.test.ts
DATE_SCRATCH_ROOT=/verified/scratch node --disable-warning=ExperimentalWarning \
  packages/coreutils/scripts/date-oracle.ts --compare packages/coreutils/dist/date.wasm
bun test packages/coreutils/tests/date-wasi.test.ts
```

The oracle first verifies the GNU date executable's exact hash and version from the source receipt. `GNU_DATE` may select another path to those same pinned bytes. Clock-setting cases never invoke a native executable. Successful output comparisons use exact stdout bytes and status. Error comparisons check status and diagnostic presence, not GNU's exact wording. Help and version are metadata checks, not output-parity claims.

Three current-time comparisons install a declared fixed realtime clock only in the Node WASI test fixture. Their GNU commands use the same explicit epoch through `-d`, without changing the host clock. Every successful date execution in that fixture must actually read its declared clock. The actual Waffle runtime test does not install this fixture. It exercises real time, real file metadata, lazy loading, canonical and alias identity, one source fetch, and removal on the caller's single runtime.

Every native and guest subprocess has a deadline. Oracle scratch files are removed in `finally`. The optional native-date argument to `--compare` also checks the non-clock-setting fixtures against the native build of this leaf.
