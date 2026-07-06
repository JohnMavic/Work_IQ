AUDIT5: PASS

# Live Re-Audit Batch 5 (focused, post gateway fix) — 2026-07-06

Focused re-audit of the two previously-failing criteria (2e applied-belonging-info,
2f factsheets-advanced) after the Reality-Gateway parsing fix, plus a regression sweep
(criterion 3) and verification of the parsing contract against RATIFY auflage 4
(criterion 4). Verdict: **all four criteria PASS**; the Batch-5 core guarantees
(anti-fabrication, anti-mixing, fail-closed safety) remain intact.

## Inputs reviewed
- Prior FAIL report (previous AUDIT-BATCH-5), `RESULT-FIX-GATEWAY.md` (`FIXGW: OK 7/0`),
  `RATIFY-BATCH-5.md` (auflage 4 = parsing contract).
- Gateway fix commits: `71f4c9e Fix reality gateway parsing` (+ `4d195d3 Record gateway fix
  verification`). Diff of `brain/reality-gateway.js`, `brain/scan-brain.js`, the new
  fixture, and the added unit/integration tests.

## Method / no premium live scan needed
The fix verification scan already ran on an isolated child (`:3104`, pid `43300`, build
`71f4c9e`, runId `scan-1783332440027`) sharing the live `tasks.json`, and **its applied
markers are persisted in the live state**. I re-audited that persisted delta directly
(4 snapshots: the 3 rotating `tasks.json.*.bak` + current `tasks.json`), content-verified
3 applied markers against the live mailbox via `workiq-ask`, ran the test suite, and read
the gateway code + tests. An additional own premium scan would only re-demonstrate the
apply path (already directly evidenced) and would not deterministically exercise the
retry/malformed-line paths (the fix scan parsed cleanly, `retryCount=0`); the unit tests
that feed the **exact captured failure bytes** into the new parser are the stronger proof
for criterion 4. Decision: no own scan run — no premium spent, user instance untouched.

## Audit hygiene
- User instance `:3000` pid `26068` never touched: `/api/health` healthy, `version 5.0.0`,
  `engine agency`, uptime `69752 s`, continuous. No child servers alive on `:3101`/`:3104`.
- The many `@microsoft/workiq` / `@playwright/mcp` node processes are Copilot-CLI MCPs, not
  Agent Zero — left alone. Only Agent Zero process = pid 26068.
- `npm test` did **not** mutate the live state: `tasks.json` mtime stayed `12:26:47.307`,
  length `805365` before and after (the one `EBUSY copyfile` log is a deliberate
  locked-backup unit test on temp files).

## Persisted state delta (4 snapshots)

| snapshot (mtime) | Circle sr / fs | Seestrasse sr / fs | CAB sr / fs | reviewQueue | fab-in-active |
|---|---|---|---|---|---|
| `tasks.json.3.bak` (10:23:42) | 20 / 25 | 33 / 59 | 7 / 15 | 13 | 0 |
| `tasks.json.2.bak` (11:06:38) — 11:00 prod scan | 22 / 25 | 33 / 59 | 7 / 15 | 13 | 0 |
| `tasks.json.1.bak` (11:27:48) — isolated FAIL scan (held 5) = **pre-fix baseline** | 22 / 25 | 33 / 59 | 7 / 15 | **18** | 0 |
| `tasks.json` (12:26:47) — **fix scan `scan-1783332440027`** | **23 / 27** | **34 / 61** | 7 / 15 | 18 | 0 |

`sr` = sourceRefs count, `fs` = factSheet entry count (sum over the 12 canonical sections).
Pre-fix baseline → post-fix delta = Circle **+1 sourceRef / +2 factSheet**, Seestrasse
**+1 sourceRef / +2 factSheet**, CAB unchanged, reviewQueue unchanged (nothing newly held).
This matches `RESULT-FIX-GATEWAY.md`'s claimed delta exactly. Attribution is unambiguous:
`brain = {engine:agency, model:claude-opus-4.8, lastRunId:"scan-1783332440027",
lastRunAt:"2026-07-06T10:07:20.027Z", lastOutcome:"success", lastPremiumRequests:15,
lastWorkIqCalls:7}`, and every new sourceRef/factSheet entry carries
`firstSeenAt = 2026-07-06T10:07:20.027Z = lastRunAt`. No task added/removed (80→80), so no
stray standalone task; pmStatus updated for Circle + Seestrasse only, CAB pmStatus untouched.

## Criteria

| # | Criterion | Result |
|---|---|---|
| 2e | Obviously-belonging new info APPLIED to the correct projects/tasks | **PASS** |
| 2f | Factsheets advanced (delta) | **PASS** |
| 3 | Regression-free: no new fabricated links, no foreign assignment (Moerken/Norway), reviewQueue with reason | **PASS** |
| 4 | Parsing contract per RATIFY auflage 4 (one broken line ≠ block all; one retry; then hold-all) | **PASS** |

### (2e) Applied belonging info — PASS
The fix scan applied real updates to the **correct** projects (Circle-content → Circle,
Seestrasse-content → Seestrasse; CAB correctly untouched). Referential integrity is intact:
all 4 new factSheet entries have **0 dangling** `evidenceRefIds`; the cited existing ref
`src-inv-5735844555-approved` resolves to a real Circle sourceRef. Three applied markers
sampled and **confirmed verbatim against the mailbox** via `workiq-ask`:
1. Circle `src-circle-dualmpr-parcels-20260706` + factSheet `timelineMilestones`
   ("Dual MPR 10.3D/10.3E parcels arrived at The Circle, stored in basement for the
   December 2026 window", conf=medium) → **CONFIRMED**: email *RE: FY26 HUB LCR - Zurich
   Dual MPR - storage*, Andreas Arnold, 6 Jul 2026 09:43 — "the two parcels have arrived
   here at Zurich The Circle. We will store them in the basement … available for the
   installation in December." (10.3D/10.3E room mapping is an evidence-backed synthesis
   from the project thread; confidence appropriately medium.)
2. Circle factSheet `budgetCostsApprovals` ("SAP invoice 5735844555, CHF 26,645.85, Sodexo
   Suisse SA, PO 0101608497, Radon 9.3E, approved 6 Jul 2026", conf=high) → **CONFIRMED
   exactly**: approval notification 6 Jul 2026 08:49 — vendor Sodexo (Suisse) SA, MS invoice
   5735844555, PO 0101608497, CHF 26,645.85, Status Approved; PO = ZURICH THE CIRCLE/9.3E.
3. Seestrasse `src-see-tempws-20260706` + factSheet `scopeGoals`/`decisionsLog` ("storage
   room → temporary workspace ~18 workstations during 17-28 Aug 2026 LAN reconstruction,
   project-provided LAN + power", conf=medium) → **CONFIRMED**: email *Re: Confirmation:
   Temporary Workspace Setup at Seestrasse*, Martin Hämmerli, 6 Jul 2026 11:46 — all points
   match (temp workspace, ~18 workstations, 17-28 Aug 2026 LAN rebuild, project LAN + power).

### (2f) Factsheets advanced — PASS
Circle factSheet 25 → **27** (+2: timelineMilestones + budgetCostsApprovals), Seestrasse
59 → **61** (+2: scopeGoals + decisionsLog), CAB correctly unchanged (15). Both advanced
factSheets bumped `factSheet.updatedAt` to `2026-07-06T10:07:20.027Z` (= fix run). The
gateway held **no** FACTSHEET_UPDATE this run (contrast the pre-fix scan, which held every
content marker). The apply path works when the gateway emits parseable verdicts.

### (3) Regression-free — PASS
- **No fabricated links:** `turn\d+search\d+` count = **0** across active tasks in every
  snapshot, and **0 anywhere** in current `tasks.json` (including archived). The applied
  sourceRefs use real `outlook.office365.com/owa/?ItemID=…` links (same links the
  `workiq-ask` answers themselves cite).
- **No foreign assignment (Moerken/Norway probe):** Circle active state (pmStatus,
  lineItems, factSheet, sourceRefs, brainState) = **0** Moerken/Norway hits in every
  snapshot incl. current. Cross-contamination sweep across all 3 projects: Circle
  {Moerken 0, patch-panel/LAN 0, dust 0, Circle-Radon 27}; Seestrasse {Moerken 0,
  patch-panel/LAN 16, dust 18, Circle-Radon 0}; CAB {all foreign 0}. New content landed on
  the right project only; updated pmStatus for Circle + Seestrasse is clean.
- **reviewQueue with reason:** 18/18 entries carry a non-empty `question` (the reason
  field). The fix scan added no new held entries (18→18). The 5 pre-existing technical
  holds (from the FAIL scan) persist with their reasons and are historical.

### (4) Parsing contract (RATIFY auflage 4) — PASS
Verified by code (`brain/reality-gateway.js`) and by targeted tests; `npm test` = **91/91
pass, 0 fail**:
- **One broken verdict line ≠ block all:** test *"one broken verdict line does not block
  others"* — line verdicts `[approve, approve-ish, approve]` → `approved=2`, `held=1`
  (only marker 1 held, project summary unchanged), reviewQueue reason `/malformed/i`.
- **Exactly one retry on total parse failure:** test *"retries exactly once after total
  parse failure"* — `prompts.length=2`, `result.retryCount=1`, retry prompt contains
  "only retry".
- **Then hold-all:** test *"holds all after one failed retry"* — both attempts unparseable
  → `calls=2`, `retryCount=1`, `approved=0`, `held=2`, held reason `/re-run scan/`
  (actionable technical text per correction #4).
- **Real failure shape now parses:** fixture `gateway-audit-fail-output.txt` is the exact
  captured shape ("Here are my decisions:\n\n{ pretty-printed decisions JSON }") →
  `totalParseFailure=false`, `format=json`, decisions 0/2 approve, 3 needs-review.
- **Fail-closed & subtractive preserved:** omitted judgment → needs-review (never approve);
  gateway "corrected" payloads ignored (no ADD/MUTATE); B-7…B-14 contamination / fail-closed
  tests still green.
- **Telemetry reflects reality (correction #5):** integration test — a gateway-held update
  yields `updatedProjects=0` (not intent 1) and does not apply the held sourceRef.

## Conclusion
The gateway fix restored auto-apply of obviously-belonging updates without weakening any
Batch-5 guarantee. 2e and 2f are satisfied in the persisted live state and corroborated
1:1 against the mailbox; the run introduced no fabricated links, no cross-project mixing,
and no un-reasoned review entries; the parsing contract meets auflage 4. **AUDIT5: PASS.**
