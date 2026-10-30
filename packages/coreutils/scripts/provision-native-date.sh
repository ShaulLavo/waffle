#!/usr/bin/env bash
set -euo pipefail
here=$(cd -- "$(dirname -- "$0")" && pwd)
: "${GNU_DATE_ORACLE_ROOT:?Set an owned native cache path}"
: "${GNU_DATE_ORACLE_SCRATCH_ROOT:?Set a verified scratch parent}"
mkdir -p -- "$GNU_DATE_ORACLE_SCRATCH_ROOT"
scratch=$(mktemp -d "$GNU_DATE_ORACLE_SCRATCH_ROOT/date-provision-XXXXXX")
child=''
cleanup() {
  code=$?
  trap - EXIT INT TERM
  if [[ -n "$child" ]]; then
    kill -TERM -- "-$child" 2>/dev/null || true
    wait "$child" || true
  fi
  rm -rf -- "$scratch"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
export GNU_DATE_ORACLE_SCRATCH_ROOT="$scratch"
setsid timeout --kill-after=5s 600s node "$here/build-native-date-oracle.ts" "$@" &
child=$!
wait "$child"
