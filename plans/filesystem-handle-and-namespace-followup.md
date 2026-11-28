# Filesystem handoff and synthetic namespace follow-up

The cooperative descriptor fix limits its lifetime changes to guarded lookup.

- Carry explicit final-handle leases through ordinary filesystem lookup and creation. Verify allocation failures before create or truncate.
- Apply the same pin ownership discipline to ordinary MultiTab lookup and mutation handoffs. Preserve the existing rule against replaying mutations whose outcome is unknown after a term change.
- Unify the synthetic device and descriptor namespace policies used by cooperative and standard Preview 1 lookups. Keep the existing raw descriptor reopen and virtual machine-id conformance controls.
