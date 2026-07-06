FIXGW: OK 7/0

# Result Fix Gateway — 2026-07-06

## Code
- Commit: `71f4c9e Fix reality gateway parsing`.
- Gateway contract changed from strict whole-response JSON to line verdicts:
  `GATEWAY_DECISION<TAB>markerIndex<TAB>approve|reject|needs-review<TAB>reason`.
- Backward-compatible JSON fallback now extracts prose-prefixed pretty `decisions` JSON with a
  balanced brace scan. No semantic repair is performed.
- Exactly one retry is issued only after total parse failure. A partial line parse remains
  fail-closed per affected line, not hold-all.
- Technical gateway failures now produce actionable review text: re-run scan, with technical detail.
- Scan result counters now report post-apply diff counts, not `SCAN_DONE` intent.

## Regression
- `npm test`: 91/91 pass.
- Added regression for the Audit Batch 5 failure shape: prose prefix plus pretty `decisions` JSON.
- Added regression proving one malformed `GATEWAY_DECISION` line does not block other verdicts.
- Added retry tests: exactly one retry on total parse failure, then hold-all if retry also fails.
- Added integration test proving held updates no longer inflate `updatedProjects`.

## Live Verification
- Diagnostic before process work: user instance remained on `:3000`, pid `26068`, engine `agency`.
- Final isolated child server: `:3104`, pid `43300`, build `71f4c9e`, engine `agency`.
- Job: `a15336e8-5aa1-43d7-b4e1-56cd5a189de2`, runId `scan-1783332440027`.
- Result: `outcome=success`, `appliedMarkers=7`, `gateway.approvedMarkers=7`,
  `gateway.heldMarkers=0`, `gateway.parsed=true`, `gateway.retryCount=0`.
- The own child pid `43300` was stopped after verification. User instance `:3000` stayed healthy.

## State Delta
- Baseline: 80 tasks, 24 active, reviewQueue 18, active fabricated tokens 0, Circle Moerken/Norway 0.
- After live scan: 80 tasks, 24 active, reviewQueue 18, active fabricated tokens 0,
  Circle Moerken/Norway 0.
- `proj-zurich-circle-hublcr`: sourceRefs 22 -> 23, factSheet entries 25 -> 27,
  factHash `bfc04d920fda3046` -> `238287fd8e426bc7`.
- `proj-seestrasse-356`: sourceRefs 33 -> 34, factSheet entries 59 -> 61,
  factHash `da894710001a8c02` -> `baecd00231827c06`.
- `proj-msde-cab`: unchanged.

Criteria 2e and 2f are satisfied: belonging project information was applied, and factSheets were
advanced in the live state.
