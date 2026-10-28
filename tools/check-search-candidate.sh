#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
cleanup() {
  rm -rf -- "$root/.work"
  rmdir "$root/packages/sed/.build" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
mkdir -p .work
node --test packages/sed/scripts/test-sed-source.ts packages/ripgrep/scripts/test-rg-source.ts
node --test tools/test-family-build-routes.ts
python3 tools/check-search-candidate.py
cargo metadata --offline --locked --format-version 1 --manifest-path packages/sed/Cargo.toml > .work/sed-metadata.json
cargo fmt --manifest-path packages/sed/Cargo.toml --check -p shell-sed
