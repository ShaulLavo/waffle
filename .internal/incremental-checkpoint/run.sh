#!/usr/bin/env bash
set -euo pipefail

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
base=4d79516d35d2b72d099b0800a3b2b8e18d712ddb
out=$(realpath -m -- "${1:?Pass a new external evidence directory}")
mode=${2:-both}
repetitions=${WAFFLE_CHECKPOINT_REPETITIONS:-3}
[[ "$repetitions" =~ ^[1-9][0-9]?$ ]] || exit 2
[[ "$mode" == prototype || "$mode" == control || "$mode" == both || "$mode" == phases ]] || exit 2
[[ "$out" != "$repo/"* && "$out" != "$repo" && ! -e "$out" && ! -L "$out" ]] || exit 2
[[ $(findmnt -n -o TARGET -T /work/tmp) == /work ]] || exit 2
scratch=$(mktemp -d /work/tmp/w294-test-XXXXXX)
cleanup() {
  find "$scratch" -depth -delete
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
export WAFFLE_CHECKPOINT_EXPERIMENT_REVISION
WAFFLE_CHECKPOINT_EXPERIMENT_REVISION=$(git -C "$repo" rev-parse HEAD)
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
    if [[ "$arm" == prototype || "$arm" == phases ]]; then
      bun "$here/install.ts" "$source/packages/waffle"
    else
      git apply "$here/counters.patch"
    fi
    if [[ "$arm" == phases ]]; then
      cp "$here/controls.ts" packages/waffle/tooling/checkpoint-controls.ts
      cp "$here/dead-writer.ts" packages/waffle/tooling/checkpoint-dead-writer.ts
      cp "$here/crash-before-checkpoint.ts" packages/waffle/tooling/checkpoint-crash-before.ts
      cp "$here/control-runner.ts" packages/waffle/tooling/checkpoint-control-runner.ts
      if [[ "${WAFFLE_CHECKPOINT_TYPECHECK:-0}" == 1 ]]; then
        git -C "$repo" archive "$base" packages/waffle-relay packages/diffutils tools | tar -x -C "$source"
        ln -s -- "$repo/node_modules" "$source/node_modules"
        ln -s -- "$repo/packages/waffle/node_modules" "$source/packages/waffle/node_modules"
        ln -s -- "$repo/packages/waffle-relay/node_modules" "$source/packages/waffle-relay/node_modules"
        "$repo/packages/waffle/node_modules/.bin/tsc" -p packages/waffle
      fi
      bun packages/waffle/tooling/checkpoint-control-runner.ts | tee "$out/phases.json"
      return
    fi
    bun "$here/timing.ts" "$source/packages/waffle" "$arm"
    local log="$scratch/$arm.log"
    bun packages/waffle/tooling/vfs-benchmark.ts --output "$scratch/results-$arm" \
      --campaign "checkpoint-$arm" --browsers chromium --workloads W6 --lanes guest \
      --cells chromium/indexeddb/W6/guest > "$log" 2>&1 || {
      tail -n 20 "$log" >&2
      exit 1
    }
    bun "$here/evidence.ts" "$log" "$arm" "$repetitions" > "$out/$arm.json"
  )
}

if [[ "$mode" == phases ]]; then
  run_cell phases
else
  if [[ "$mode" != control ]]; then run_cell prototype; fi
  if [[ "$mode" != prototype ]]; then run_cell control; fi
fi
