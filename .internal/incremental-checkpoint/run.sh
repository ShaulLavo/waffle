#!/usr/bin/env bash
set -euo pipefail

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
base=$(git -C "$repo" rev-parse HEAD)
out=$(realpath -m -- "${1:?Pass a new external evidence directory}")
mode=${2:-both}
repetitions=${WAFFLE_CHECKPOINT_REPETITIONS:-3}
[[ "$repetitions" =~ ^[1-9][0-9]?$ ]] || exit 2
[[ "$mode" == prototype || "$mode" == control || "$mode" == both ]] || exit 2
[[ "$out" != "$repo/"* && "$out" != "$repo" && ! -e "$out" && ! -L "$out" ]] || exit 2
[[ $(findmnt -n -o TARGET -T /work/tmp) == /work ]] || exit 2
scratch=$(mktemp -d /work/tmp/w294-test-XXXXXX)
cleanup() {
  rm -rf -- "$scratch"
  test ! -e "$scratch"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir "$out" "$scratch/deps"
for dependency in playwright playwright-core; do
  cached="/work/cache/bun-install-cache/${dependency}@1.64.1@@@1"
  test -f "$cached/package.json"
  ln -s -- "$cached" "$scratch/deps/$dependency"
done
export NODE_PATH="$scratch/deps"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/work/cache/ms-playwright}"
export STORAGE_SCRATCH_ROOT="$scratch"
export WAFFLE_CHECKPOINT_PROBE_BASE="$base"
export GIT_DIR
GIT_DIR=$(git -C "$repo" rev-parse --absolute-git-dir)

run_cell() {
  local arm=$1
  local source="$scratch/$arm"
  mkdir "$source"
  git -C "$repo" archive "$base" packages/waffle | tar -x -C "$source"
  (
    cd "$source"
    export GIT_WORK_TREE="$source"
    git apply --check "$here/workload.patch"
    git apply "$here/workload.patch"
    sed -i "s/warmups: 2, repetitions: 9/warmups: 1, repetitions: $repetitions/" packages/waffle/tooling/vfs-score-config.ts
    if [[ "$arm" == prototype ]]; then
      bun "$here/install.ts" "$source/packages/waffle"
    else
      git apply "$here/counters.patch"
    fi
    bun packages/waffle/tooling/vfs-benchmark.ts --output "$scratch/results-$arm" \
      --campaign "checkpoint-$arm" --browsers chromium --workloads W6 --lanes guest \
      --cells chromium/indexeddb/W6/guest > "$out/$arm.log" 2>&1 || {
      tail -n 20 "$out/$arm.log" >&2
      exit 1
    }
  )
}

if [[ "$mode" != control ]]; then run_cell prototype; fi
if [[ "$mode" != prototype ]]; then run_cell control; fi
