BATCH9H: OK

Implemented Loop-Fix 9H for AUDIT9 FINAL-3 FAIL a,d.

Changes:

- Added the standalone `NODE_OBSOLETE` marker for stale `pmStatus.planned`, `pmStatus.waitingOn`, and `lineItems`.
- `NODE_OBSOLETE` validates task/node existence, a past date, and `obsoleteReason`; evidence is optional.
- The applier now books only the node obsolete state and reason. It does not replace `pmStatus`, does not touch unrelated `waitingOn`, and does not assert completion.
- Temporal gate recognizes `NODE_OBSOLETE` as addressing stale nodes.
- Task-chat scope, embedded marker grammar, Agency scan skill, and gateway prompt document that temporal bookings must be standalone `NODE_OBSOLETE`, never bundled into `PROJECT_UPDATE`.
- Gateway prompt now treats `NODE_OBSOLETE` as a narrow stale-date disposition, not a completion claim.
- Attachment protocol now requires one alternate WorkIQ retry for `content-not-indexed`.
- `failed(content-not-indexed)` ledger entries get `attachmentIndexAttempts`, `reprobeNextScan`, and an automatic reviewQueue note: `attachment not indexed yet — re-probe next scan`.
- Processing cursor/thread cursor no longer advances over `failed(content-not-indexed)` attachment items until content is harvested or three scans have attempted it.

Tests:

- `NODE_OBSOLETE` validator/applier fixture.
- `NODE_OBSOLETE` gateway narrow-handling and temporal-gate fixture.
- `failed(content-not-indexed)` retry/cursor fixture.
- Prompt string asserts for `NODE_OBSOLETE`, standalone temporal bookings, content-not-indexed retry, and re-probe review note.
- `npm test` -> 153/153 passing.

Safety:

- No STOP/START scripts.
- No process cleanup or process kills.
- Existing uncommitted `AUDIT-BATCH-9.md` and `STATE.md` user/audit changes were not edited.
