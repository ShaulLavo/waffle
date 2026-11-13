# Worker lifecycle and publication command

Status: Approved. Implemented. Independent review, hosted CI, merge and native qualification remain with the parent coordinator.

Each browser observation owns immutable Worker metadata, stable identity, ordered lifecycle replay and exact-object close waits for one document generation. The original URL bridge keeps its latest-creation lookup and historical closed promises. Browser close is an ordering observation, not proof of thread joining or resource reclamation.

Page action revocation is independent of lifecycle delivery. Owned peer close enters the closing state before the window command. Matching target destruction and listing removal retain final browser events. A missing Worker event after exact close retirement is receipt-unconfirmed, not a document-close failure. Wrong generation, stream loss, unexpected navigation and missing explicit Worker termination receipts remain failures. Per-generation driver owners and collector queries retain their actual callback and query debt through cleanup.

Both complete publication modes run the unchanged fixtures through the shared page host, including their negative controls and original 180-second budgets. Source controls check exact fixture bytes, ordered labels and the extracted original desktop dispatcher. Cross-tab and recovery remain separate follow-on units. Their fixture bodies and test-only transforms are unchanged.

Linux desktop controls pass both modes in Chromium and Playwright WebKit. Firefox ordinary passes. Its workspace command rejects the same absolute-URL close lookup that the original desktop command rejects, because Firefox reports the relative script URL. Linux Playwright WebKit did not deliver Worker close after peer-page closure in the bounded peer control. The adapter reports that missing event instead of synthesizing it. Neither limitation is an actual iOS Safari qualification result.

The filesystem backend is excluded and unchanged. No runtime version bump or release is included.
