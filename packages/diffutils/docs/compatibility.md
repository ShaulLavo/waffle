# diffutils compatibility

This package compiles the GNU diffutils 3.12 `diff` and `cmp` implementations. It does not substitute a JavaScript diff algorithm or recognize a fixed set of command lines.

The 24-case corpus in `tests/cases.ts` runs against native GNU diffutils 3.12 and the staged Wasm guests with identical files, arguments, stdin, locale, and timezone. It compares exit status, stdout, and stderr exactly. Covered workflows include unified and context output, custom context widths, `-q`, `-r`, `-N`, `-w`, `-b`, ordinary and silent `cmp`, `cmp -l`, stdin, missing files, and exit statuses 0, 1, and 2.

The Waffle acceptance test runs the same corpus through the optional on-demand catalog. Unified and context file headers are excluded there because the in-memory filesystem assigns different timestamps. Wasmtime still checks those headers exactly.

## Scope and known differences

- Only `diff` and `cmp` are packaged. GNU `diff3` and `sdiff` need subprocess and wait APIs that this bounded package does not provide.
- WASI has no subprocess support here. The `--paginate` path reports an error instead of starting `pr`.
- Signal actions and masks are stubs on WASI. Waffle interruption still applies at the runtime boundary.
- Directory sorting uses byte order on WASI. Native locale-specific collation and locale error recovery are unavailable.
- Timezone environment changes do not call `tzset` on WASI. Tests use `TZ=UTC`; native and Wasm timestamps then match.

## Recheck

```sh
node packages/diffutils/tests/record-oracle.ts
node packages/diffutils/scripts/test-diffutils.ts
bun test packages/diffutils/tests/diffutils-wasi.test.ts
```

Set `WASMTIME` if Wasmtime is not on `PATH`. `GNU_DIFF` and `GNU_CMP` can select the native 3.12 oracle executables. Every subprocess has a 15-second deadline. `dist/diffutils.sizes.json` records raw, name-stripped, and Brotli sizes for each guest.
