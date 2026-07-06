BATCH7: OK 34/0 actions, 34 ledger-items

- Implemented targeted thread/action proof enforcement, truth-tree node state fields, processing ledger/cursor persistence, ledger quality gate, conflict surfacing, and the UI processing header.
- Added Batch 7 fixtures for stale past-date actions, CC-only/third-party-resolved actions, valid direct askQuote actions, missing-proof gateway holds, unresolved action carry-forward, ledger quality failures, conversation-id cursor continuity, and conflicts.
- Ran `node scripts/repair-action-gate.mjs --dry-run` and `--apply`; the apply wrote `tasks.json` atomically with backup rotation. Fall A and Fall B are no longer visible actions; removed payloads are preserved in `reviewQueue` and Fact Sheet status facts.
- Verification: `npm test` passed 113/113 before the live repair apply.
