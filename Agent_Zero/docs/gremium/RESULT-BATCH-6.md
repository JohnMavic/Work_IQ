BATCH6: OK tasks=16 batches=1 markers=8 applied=8 held=0 review=0 dangling=0

# Batch 6 Result

- A Re-verification sweep implemented in `scripts/reverify-tasks.mjs` with dry-run/apply, atomic write, backup rotation, Gateway + `applyMarkerBatch`, dangling-ref guard, and Sigma statistics.
- Live dry-run completed for all 16 active tasks: `tasks=16 batches=1 markers=5 applied=5 held=1 review=0 dangling=0`; no write.
- Live apply completed for all 16 active tasks: `tasks=16 batches=1 markers=8 applied=8 held=0 review=0 dangling=0`; wrote `tasks.json` with `tasks.json.1.bak`.
- B Owner explicitness: `pmStatus.userActions` is restricted to the app user; other owners are represented through line items or Fact Sheet Open Actions with owner display.
- C Done checkbox: stable user-action ids, PATCH by id, `userMarkedDoneAt`, server carry-forward over `PROJECT_UPDATE.pmStatus`, reopen/confirmed history, and UI active/done split.
- D Task chat: `/api/tasks/:id/log` now runs a task-scoped Agency Brain chat, filters markers through the Reality Gateway, applies through `applyMarkerBatch`, and holds cross-task markers.
- Tests: `npm test` passed, 98/98.
