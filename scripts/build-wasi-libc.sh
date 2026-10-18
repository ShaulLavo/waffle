#!/usr/bin/env bash
set -euo pipefail

# Waffle's single guest-libc patch, based on the revision shipped by wasi-sdk 34.
readonly revision=2e6fb9d8ee0cdf9e431fbcabe8af3115de000a13
readonly archive_sha256=f25ccd526235f7b351f9b49451b75fdd8e23250b9ad8fc9f8f2a19f517a4892f
readonly repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
readonly sdk=${WASI_SDK_PATH:-/work/cache/wasi-sdk-34.0-x86_64-linux}
readonly scratch=${WASI_LIBC_SCRATCH_ROOT:-/work/tmp}

if [[ $# != 1 || -e "$1" || -L "$1" ]]; then
  echo 'Usage: build-wasi-libc.sh NEW_OUTPUT_DIRECTORY (must not exist)' >&2
  exit 1
fi
if [[ ! -x "$sdk/bin/clang" ]] || ! grep -qx '34.0' "$sdk/VERSION" || ! grep -qx 'wasi-libc: 2e6fb9d8ee0c' "$sdk/VERSION"; then
  echo 'WASI_SDK_PATH must name wasi-sdk 34.0 with wasi-libc 2e6fb9d8ee0c' >&2
  exit 1
fi
for tool in cmake ninja curl tar patch sha256sum setsid timeout; do command -v "$tool" >/dev/null; done
# The caller chooses and verifies a data-volume scratch root before invoking us.
[[ -d "$scratch" && -w "$scratch" ]]
readonly output=$(realpath -m "$1")
readonly work=$(mktemp -d "$scratch/waffle-wasi-libc-XXXXXX")
active=
stop_group() {
  [[ -n "$active" ]] || return 0
  kill -TERM -- "-$active" 2>/dev/null || true
  kill -KILL -- "-$active" 2>/dev/null || true
  wait "$active" 2>/dev/null || true
  for ((attempt=0; attempt<100; attempt++)); do
    if ! kill -0 -- "-$active" 2>/dev/null; then active=; return 0; fi
    sleep 0.01
  done
  echo "Process group $active did not disappear; retained scratch: $work" >&2
  return 1
}
cleanup() {
  trap '' INT TERM
  if stop_group; then rm -rf -- "$work"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$work/tmp"
export TMPDIR="$work/tmp" TMP="$work/tmp" TEMP="$work/tmp"
# Background wait is interruptible in Bash; a foreground external command would
# defer the TERM trap until after cmake and its compiler descendants finished.
set +m
run() {
  setsid timeout --kill-after=1s "${WASI_LIBC_COMMAND_TIMEOUT_SECONDS:-600}s" "$@" <&0 &
  active=$!
  local status=0
  wait "$active" || status=$?
  stop_group || return 1
  return "$status"
}

run curl --fail --location --retry 3 --silent --show-error \
  "https://codeload.github.com/WebAssembly/wasi-libc/tar.gz/$revision" -o "$work/source.tar.gz"
printf '%s  %s\n' "$archive_sha256" "$work/source.tar.gz" | sha256sum --check --status
mkdir "$work/source"
run tar -xzf "$work/source.tar.gz" --strip-components=1 -C "$work/source"
run patch --batch --forward -p1 -d "$work/source" < "$repo/patches/wasi-libc/preopen-scan.patch"
run cmake -S "$work/source" -B "$work/build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_COMPILER="$sdk/bin/clang" \
  -DCMAKE_ASM_COMPILER="$sdk/bin/clang" \
  -DCMAKE_AR="$sdk/bin/llvm-ar" \
  -DCMAKE_NM="$sdk/bin/llvm-nm" \
  -DCMAKE_RANLIB="$sdk/bin/llvm-ranlib" \
  -DTARGET_TRIPLE=wasm32-wasip1 -DWASI_SDK_VERSION=34.0 \
  -DBUILD_SHARED=OFF -DBUILD_TESTS=OFF
run cmake --build "$work/build" --target sysroot --parallel "${WASI_LIBC_JOBS:-8}"
# Never delete a caller-owned output directory. Install only after the build succeeds.
mkdir -p "$(dirname "$output")"
mv -T "$work/build/sysroot" "$output"
printf 'Patched wasi-libc sysroot: %s\n' "$output"
