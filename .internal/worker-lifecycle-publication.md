# Worker lifecycle and publication command

Status: Approved. Implementation in progress.

The host observes each dedicated Worker through its browser identity and exact document generation. Browser close is an ordering observation, not proof of thread joining or resource reclamation. Page action revocation must not cut off final lifecycle delivery during an intentional owned close.

This unit extends BrowserObservation, the existing drivers, collector and page bootstrap. It adapts both complete publication command modes without changing their fixtures, clocks, result labels or later resource checks. Cross-tab and recovery remain separate follow-on units.

Claimed files are the lifecycle observation and driver files under `packages/waffle/tests/page-runner/`, their ownership and collector integrations, publication adapters and controls, and `publication-browser-runner.ts`. The filesystem backend is excluded.

Independent review, hosted CI, merge and native qualification belong to the parent coordinator. No runtime version bump or release is included.
