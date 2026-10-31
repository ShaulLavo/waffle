#![cfg(not(target_os = "wasi"))]

#[path = "helpers/gnu_sort_uniq_tr_contracts.rs"]
mod contracts;

#[test]
fn sort_matches_additive_gnu_usage_contracts() {
    contracts::assert_contracts(env!("CARGO_BIN_EXE_sort"), "sort", 10);
}

#[test]
fn uniq_matches_additive_gnu_usage_contracts() {
    contracts::assert_contracts(env!("CARGO_BIN_EXE_uniq"), "uniq", 9);
}
