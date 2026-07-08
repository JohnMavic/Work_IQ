BATCH9E: OK

Implemented the loop-fix for AUDIT9 FAIL a,d in the Chat Deep Verify path.

Changes:

- Chat Deep Verify now runs accepted task mutation markers through the same processing-ledger quality gate used by scans before applying markers.
- Microsoft 365 deep verification with task mutations is held unless it provides `SCAN_DONE.processingQuality.required`, enumerated items, and `processingLedger` dispositions with `attachmentsHandled`.
- Messages enumerated with attachments are rejected when their ledger disposition leaves `attachmentsHandled:"none"` instead of `yes`, `yes(workiq-index)`, or `failed(<reason>)`.
- Chat Deep Verify now runs `evaluateTemporalPassGate` before marker apply, scoped to the current task. Stale unconfirmed `pmStatus.planned`, `pmStatus.waitingOn`, and line-item dates must be freshly confirmed or explicitly marked obsolete/superseded.
- The deep-verification prompt now makes attachment probing a mandatory workflow step before answering or emitting markers, and explicitly requires the temporal pass.
- Deep marker gate holds write a reviewQueue entry and mark the follow-up marker processing as `held`; no task-state mutation is applied.
- The UI refreshes on the new `marker_apply_held` progress event.

Tests:

- `node --test tests/unit/twotier-chat.mjs` -> 11/11 passing.
- `node --test tests/unit/batch9.mjs` -> 8/8 passing.
- `npm test` -> 148/148 passing.

Safety:

- No STOP/START scripts.
- No broad process kills.
- No running Agent Zero instances touched.
