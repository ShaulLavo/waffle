#![cfg(not(target_os = "wasi"))]

#[path = "../../../tests/helpers/gnu_usage_contracts.rs"]
mod contracts;

#[test]
fn wc_matches_additive_gnu_usage_contracts() {
    contracts::assert_contracts(env!("CARGO_BIN_EXE_wc"), "wc", 9);
}
