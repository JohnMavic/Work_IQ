AUDIT6: PASS

# Gremium-Abschluss-Audit Batch 6 + 6b — 2026-07-06

Adversarial audit of Batch 6 (re-verification sweep · owner explicitness · done-tickbox ·
task chat) and Batch 6b (multiline chat + image paste + English-only) against the code and
the live task store (`tasks.json`, read-only). All six audit criteria pass; the Batch-6
guarantees (single gateway apply path, sigma-safe sweep, owner discipline, two-state tickbox,
English-only) hold. Two non-blocking findings are recorded under criterion 1.

## Inputs reviewed
- `PROMPT-BATCH-6.md`, `PROMPT-BATCH-6B.md`, `RATIFY-BATCH-6.md` (GO-WITH-CONDITIONS, blocking
  item C + conditions A/B/D), `RESULT-BATCH-6.md` (`BATCH6: OK … markers=8 applied=8`),
  `RESULT-BATCH-6B.md` (`BATCH6B: OK`, 104/104).
- Commits `6b8b2dc` (owner) · `8684e68` (task chat→brain) · `0b40168` (reverify sweep) ·
  `96535fc` (image attachments) · `13a2c20` (English) · `347d239` (batch6b tests).
- Code: `brain/{user-actions,task-chat,attachments,agency-cli,brain-runner,marker-applier,
  reality-gateway,render-scan-state}.js`, `scripts/reverify-tasks.mjs`, `server.js`,
  `index.html`, `docs/AGENCY_BRAIN_SCAN_SKILL.md`, `tests/unit/batch6*.mjs`.

## Method / no own live scan
The sweep (`data.brain.lastRunId=batch6-live-full-apply`, `lastRunAt 2026-07-06T14:04:20.491Z`)
already ran and its applied delta is persisted in the live store, so I audited the persisted
state directly (4 snapshots: `tasks.json` + 3 rotating `.bak`) plus the code and tests, and
content-verified 4 claims of the re-verified projects against the live mailbox through the
independent M365 Copilot `workiq-ask` tool. A fresh premium scan would only re-demonstrate the
apply path (already evidenced) — none run, no child server started, user instance untouched.

## Audit hygiene
- User instance `:3000` pid `26068` (`node server.js`, started `2026-07-05T17:10:20` local)
  never touched; `.agent-zero.lock` unchanged (pid 26068). No child server on `31xx`. No
  STOP/START scripts, no broad kills.
- `tasks.json` unchanged by the audit: SHA256 prefix `938F6EA24A0682AF` before and after,
  incl. before/after `npm test` (mtime `2026-07-06T16:36:14`). Only this file + `STATE.md`
  were written. All analysis ran from the session workspace, not the repo.

## Persisted sweep footprint (8 markers, one substantive change)
Objects stamped with the sweep run time `14:04:20.491Z` = 8: four legacy single tasks
(`47f48321`, `d94f7989`, `a9b19832`, `54e6acf3` — empty placeholders, only `updatedAt`
bumped), `proj-seestrasse-356` + `proj-msde-cab` (`updatedAt` only), and `proj-zurich-circle-
hublcr` (`factSheet.updatedAt` + the one substantive entry `decisionsLog` "SAP invoice
5735844555 …"). Σ is **identical** across all four snapshots
(`pm=29 li=19 fs=110 sr=67 hist=799 rq=18`), 0 dangling refs, 0 fabricated links → the sweep
was verlustfrei and, on an already-clean Batch-5 base, mostly a no-op re-confirmation.

## Criteria

| # | Criterion | Result |
|---|---|---|
| 1 | Sweep quality: 4/8 applied corrections mailbox-checked; Σ-invariants | **PASS** (2 non-blocking notes) |
| 2 | Owner explicitness (userActions = only the app user; foreign owners named; UI shows owner) | **PASS** |
| 3 | Done-tickbox (data model + reconcile + UI; clean two-state model; contradiction path) | **PASS** |
| 4 | Task chat via brain-runner + gateway (one apply path); 10-min timeout; multiline; image paste `--attachment`; upload guards | **PASS** |
| 5 | English-only (prompts carry the rule; UI labels English; no German in generated fields) | **PASS** |
| 6 | Regression-free (no fabricated links, no foreign assignment; npm test) | **PASS** |

### (1) Sweep quality — PASS
4 substantive claims of the re-verified projects sampled via `workiq-ask` and **confirmed
verbatim against the mailbox**:
1. Circle `factSheet.budgetCostsApprovals`/`pmStatus.current` — SAP invoice **5735844555,
   Sodexo (Suisse) SA, CHF 26,645.85 gross, PO 0101608497, Room Radon 9.3E, Approved** →
   exact match (this is the one substantive sweep-applied entry).
2. Circle `timelineMilestones` — Dual MPR 10.3D/10.3E **parcels arrived at Zurich The Circle,
   stored in the basement, installation December 2026** → exact match (Andreas Arnold,
   6 Jul 2026).
3. Seestrasse `scopeGoals` + userAction — storage room → **temporary workspace ~18
   workstations**, **LAN reconstruction 17–28 Aug 2026**, **Laith Skeik meeting request
   unanswered** → exact match.
4. CAB `scopeGoals` — **02-Jul-2026 CAB session held; IT Change Governance issued agenda
   (13:44) and minutes (18:16)** → exact match.
Σ-invariants held (identical counts across 4 snapshots, 0 dangling, 0 fabrication);
`reverify-tasks.mjs` runs the gateway + `applyMarkerBatch` path with dry-run/apply, atomic
backup rotation, removed-entry→reviewQueue archival, and a dangling-ref abort gate (test
"A reverify dry-run does not write, apply writes removed pmStatus entry to reviewQueue" green).
- **Non-blocking note A:** the CAB claim `decisionsLog` "CHG0858097 … approved and **completed
  16–17 May 2026**" (conf=medium) is only mailbox-verifiable as **"Scheduled"** in the
  14-May CAB minutes; completion is not evidenced. This entry predates Batch 6 (the CAB task
  carries `brainState.lastScanRunId=factsheet-bootstrap-…`, not the sweep) — not a Batch-6
  regression, but recommend re-verifying or downgrading the "completed" wording.
- **Non-blocking note B:** the sweep's `data.brain` shows `lastOutcome:"partial"` and
  `lastWorkIqCalls:0`. This is the brain's self-reported SCAN_DONE value (not the runner's
  actual counter, which is not persisted), so it does not by itself prove zero mailbox reads;
  combined with note A it suggests the sweep re-verification was shallow. Because the applied
  data is correct and Σ-safe, this does not fail the criterion, but future sweeps should
  guarantee genuine WorkIQ re-verification of medium-confidence claims.

### (2) Owner explicitness — PASS
- **0** non-user owners inside `pmStatus.userActions` across all 80 tasks; every Circle/
  Seestrasse/CAB userAction carries `[user]`. Validator `marker-applier.js:234` rejects
  `PROJECT_UPDATE`/`PROJECT_NEW` whose `userActions` entry has a non-user `owner`
  ("pmStatus.userActions entries must be owned by the app user"); `owner:"user"` addition is
  additive (`validatePmStatus` only requires `text`).
- Foreign-owner actions live in `lineItems` (`owner` field) / Fact Sheet `openActions`
  (rendered "Owner: X"). UI `ownerChip()` (index.html:2841) shows **"You"** for the user and
  **"Owner: <name>"** otherwise, on pm entries and line items. Skill `docs/AGENCY_BRAIN_SCAN_
  SKILL.md:71-73` enforces the same. Test "B foreign-owner action is rejected from userActions
  and can be preserved as owned line item" green.

### (3) Done-tickbox — PASS
- **Data model:** `userMarkedDoneAt` + stable identity (`stableUserActionId` = sha1 of a
  content key) in `brain/user-actions.js`.
- **Carry-forward (RATIFY C, blocking):** `mergeUserActionCarryForward` re-attaches the stored
  `userMarkedDoneAt` (+ `owner`) to identity-matched actions when the incoming
  `PROJECT_UPDATE.pmStatus` full-replace omits the flag — server-side, not LLM-driven
  (`marker-applier.js:588`). Test "C userMarkedDoneAt survives PROJECT_UPDATE carry-forward"
  green.
- **PATCH:** `PATCH /api/tasks/:id` with `userActionId`+`userMarkedDoneAt` locates the action
  by id, sets/clears the flag (undo), validates ISO/`null`, 404 on unknown id, writes a
  `user-action-marked-done` / `unmarked-done` history entry — no blind `t[field]` write
  (server.js:2497-2528).
- **Reconcile (exactly two transitions):** confirmed-closed ⇒ `user-action-confirmed` history
  event, evidence kept (`user-actions.js:162`); still-open/reopened ⇒ re-emit with
  `userMarkedDoneAt:null` + `user-action-reopened` hint (skill:75-76, merge:145). The scan
  state doc renders `markedDoneAt=<date>` / `active` per action (`render-scan-state.js:123`) so
  the brain can judge. UI splits active vs a collapsible "Marked done by you (n)" section with
  a done-pending badge and reopened hint (index.html:2849-2894). Test "C confirmed and
  contradicted user-marked actions reconcile through history and active split" green.

### (4) Task chat — PASS
- **Exactly one apply path (RATIFY D):** frontend `analyzeLog` → `POST /api/tasks/:id/log`
  (index.html:3642) → `runLogJob` → `runTaskChatOnce` →
  `filterMarkersThroughGateway` → `applyMarkerBatch` (task-chat.js:348-361). The old
  `/log/analyze` route is gone (only a stale comment at server.js:3780); no SDK direct
  pmStatus write remains in the chat path. `applyMarkerBatch` is fed the full migrated
  `tasks.json` (source-ref index resolves), while the brain context stays task-scoped.
  `scopeMarkersToTask` converts markers targeting foreign taskIds into `NEEDS_REVIEW`
  (task-chat.js:183-212); empty/invalid output mutates nothing (task-chat.js:336). Tests
  "D task chat markers go through gateway and cross-task marker is held" and "D marker-only
  invalid chat output writes nothing" green; "task log route is agency task chat and is not
  legacy-gated" green.
- **Timeout 10 min:** `DEFAULT_TASK_CHAT_TIMEOUT_MS = 10*60*1000` passed to `runBrain`
  (task-chat.js:22, 324); WorkIQ hard-limit 12.
- **Task-scoped gateway gets full factSheet** (RATIFY-5 auflage 9): `writeTaskChatState` writes
  `renderFactSheetMarkdown(task)` and passes it to the gateway (task-chat.js:76, 352).
- **Multiline (6b):** textarea `onkeydown=handleChatKeydown` — Enter sends, Shift+Enter inserts
  a newline (`event.shiftKey||isComposing` guard, index.html:3519), `autoGrowChatInput`
  grows to max-height then scrolls.
- **Image paste (6b):** `onpaste/ondragover/ondrop` wired on the textarea (index.html:3136) →
  `handleChatPaste/Drop` → `addChatAttachmentFiles` (image-only + 10 MB client guard),
  thumbnail preview with remove-X, upload via `POST /api/tasks/:id/attachments`; brain receives
  repeatable `--attachment <abs>` via `buildAttachmentArgs` (absolute + inside `uploads/` +
  exists, agency-cli.js:80-108). Conversation history renders image thumbnails
  (index.html:3282). Tests "6B agency attachment args…", "6B task chat passes image
  attachments…" green.
- **Upload guards:** `saveTaskImageUpload`/`resolveTaskAttachmentReference` enforce `image/*`
  (415), 10 MB (413), reject `..`/absolute/cross-task paths and NUL (`safeTaskUploadSegment`,
  `isPathInside`), `wx` write; Express raw limit 10 MB + 413 handler. Tests "6B image upload
  handler enforces image type and 10 MB limit" and "6B attachment references reject path
  traversal and cross-task paths" green.

### (5) English-only — PASS
- Rule present in `AGENCY_BRAIN_SCAN_SKILL.md:16`, `reality-gateway.js:392`
  ("Always write gateway reasons … in English"), `task-chat.js:125` ("Always respond and
  write generated task content in English, regardless of the user prompt language").
- UI labels English: "Status today", "Your action required", "Waiting on", "Archived",
  "Open Actions", "Marked done by you". No German label hits in index.html.
- **0** German words in generated fields (summary/pmStatus/lineItems/factSheet) of active
  tasks; the single hit is a verbatim quoted email subject ("… Anmeldung funktioniert nicht")
  in Seestrasse's Fact Sheet `sources` listing — a source title, which the spec explicitly
  keeps unchanged. Tests "6B prompt files enforce English-only generated output" and
  "6B UI uses multiline chat controls and has no known German labels" green.

### (6) Regression-free — PASS
- **0** `turn\d+search\d+` fabricated links in active tasks (and 0 anywhere in `tasks.json`);
  sampled sourceRefs use real `outlook.office365.com/owa/?ItemID=…` links, matching the links
  the `workiq-ask` answers themselves cite.
- **0** Moerken / **0** Norway hits in active-task state (Circle clean — the Batch-5
  contamination stays reverted).
- `npm test` = **104/104 pass, 0 fail** (the one `EBUSY copyfile` log is the intentional
  locked-backup unit test on temp files); live `tasks.json` hash unchanged before/after.

## Conclusion
Batch 6 + 6b meet the spec and all RATIFY-BATCH-6 conditions: the sweep is sigma-safe and its
applied corrections are mailbox-exact; user-action ownership is enforced (validator + UI) with
no foreign owner leaking into `userActions`; the done-tickbox is a clean two-state model with
server carry-forward, PATCH-by-id, and a bidirectional reconcile; the task chat runs through a
single gateway apply path with a 10-min timeout, multiline input, and guarded image
attachments; English-only is enforced in prompts and UI with no German in generated fields; and
the run introduced no fabricated links or foreign assignment with the full test suite green.
The two non-blocking notes (shallow sweep re-verification signalled by `lastWorkIqCalls:0`; a
pre-existing medium-confidence CAB "completed" claim that the mailbox only supports as
"Scheduled") are recommendations for the next sweep, not Batch-6 regressions. **AUDIT6: PASS.**
