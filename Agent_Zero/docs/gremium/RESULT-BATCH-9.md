BATCH9G: OK

Implemented Loop-Fix 9G for AUDIT9 FAIL a,d after the 9F re-audit.

Changes:

- Temporal gate is now granular in scan and task-chat deep verification paths. Approved markers are applied even when unrelated stale nodes remain unreconciled.
- Unaddressed stale nodes now create automatic reviewQueue entries with `stale date unreconciled: <node>` instead of holding the whole marker batch.
- Temporal result telemetry now separates real held markers from review items (`heldMarkers` vs `reviewItems`).
- `PROJECT_UPDATE.pmStatus` preserves omitted stale `planned` / `waitingOn` nodes with `needsReview` so granular application cannot silently delete them.
- Deep verification and Agency Brain prompts now make passed planned dates obsolete/superseded by default when no completion evidence exists, using `obsoleteReason:"target date passed without completion evidence — needs re-plan"`.
- Attachment prompts now require full extraction after each content capture: all dates, milestones, scope items, quantities, port counts, and names, separately per attachment filename.

Tests:

- Temporal granular chat fixture: 2 valid markers applied, 3 stale reviewQueue entries written, 0 held markers, no `marker_apply_held`.
- Scan temporal fixture updated to verify stale reviews do not hold approved markers.
- Prompt string asserts cover the obsolete default and attachment extraction checklist.
- `npm test` -> 150/150 passing.

Safety:

- No STOP/START scripts.
- No broad process kills.
- No Agent Zero or WorkIQ process touched.
