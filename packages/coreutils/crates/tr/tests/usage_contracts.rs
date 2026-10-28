#![cfg(not(target_os = "wasi"))]

#[path = "../../../tests/helpers/gnu_sort_uniq_tr_contracts.rs"]
mod contracts;

#[test]
fn tr_matches_additive_gnu_usage_contracts() {
    contracts::assert_contracts(env!("CARGO_BIN_EXE_tr"), "tr", 9);
}
