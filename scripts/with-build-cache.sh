#!/usr/bin/env bash
# Run any build command with a checkout-owned target and a private cache server.
set -euo pipefail
if [[ ${OS:-} == Windows_NT ]]; then
  exec "$@"
fi
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$root/target}
if [[ ${BUILD_CACHE:-1} == 0 ]] || ! command -v sccache >/dev/null; then
  exec "$@"
fi
if [[ -z ${SCCACHE_DIR:-} ]] && mountpoint -q /work 2>/dev/null; then
  export SCCACHE_DIR=/work/cache/sccache
fi
socket_dir=$(mktemp -d "${SCCACHE_SOCKET_ROOT:-/tmp}/sc.XXXXXXXX")
export SCCACHE_SERVER_UDS=$socket_dir/server
export SCCACHE_IDLE_TIMEOUT=60
export RUSTC_WRAPPER=${RUSTC_WRAPPER:-$(command -v sccache)}
export CMAKE_C_COMPILER_LAUNCHER=${CMAKE_C_COMPILER_LAUNCHER:-$(command -v sccache)}
export CMAKE_CXX_COMPILER_LAUNCHER=${CMAKE_CXX_COMPILER_LAUNCHER:-$(command -v sccache)}
cleanup() {
  sccache --stop-server || true
  rm -rf -- "$socket_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
"$@"
