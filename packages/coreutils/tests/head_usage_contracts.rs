#![cfg(not(target_os = "wasi"))]

#[path = "helpers/gnu_usage_contracts.rs"]
mod contracts;

#[test]
fn head_matches_additive_gnu_usage_contracts() {
    contracts::assert_contracts(env!("CARGO_BIN_EXE_head"), "head", 12);
}
