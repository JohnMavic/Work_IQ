AUDIT-TT: FAIL — Stage-1 latency for the approval/status Circle question misses the <90s MUST (120.1s warm; brain 118.3s) and breached the hard <180s bar on the cold first invocation (181.1s timeout, runner salvage failed, NO answer delivered). All content criteria + trivial-path latency + Stage-2 correctness PASS; the failure is latency-only and has a clear architectural root cause (Stage-1 fast prompt performs the WorkIQ inbox scan inline instead of deferring it).

# Two-Tier Chat Final Test — Latency Measured Audit (Circle Approval Question)

**Date:** 2026-07-07 · **Branch:** `feature/agency-brain` (build `cc9083b`) · **Auditor:** GitHub Copilot CLI (isolated child instance)
**Under test:** RESULT-TWOTIER.md two-stage task chat (Stage-1 `runTaskChatFastOnce` / Stage-2 `runTaskChatDeepVerifyOnce`).

## Verdict
**AUDIT-TT: FAIL** — driven solely by the Stage-1 latency Messlatte for the Circle (approval/status) question:
- **<90s MUST:** NOT met. Warm sample = **120.1s** (brain run 118.3s).
- **Hard <180s:** BREACHED on the cold first invocation = **181.1s** → fast timeout hit, runner salvage failed (<200 salvage bytes emitted), job `failed` with `Agency brain run timed out`, **no answer delivered to the user**.

Everything else is correct: Stage-1 content, Stage-2 content, Stage-2 timing (~14–16 min, inside the 25-min window), and the trivial-question path (47.2s, no Stage-2). The two-tier separation works and is content-accurate; the defect is that the **fast stage does the slow WorkIQ inbox scan inline** (the prompt permits up to two lookups) instead of answering instantly from project state and deferring the scan to Stage-2. That inline WorkIQ scan (~40–90s each) pushes Stage-1 past the 90s bar, and on a cold start it blew the whole 180s window and could not salvage.

## Known truth (grading yardstick, from AUDIT-BATCH-8)
- The 3 Anixter/Wesco SAP invoices on PO 0101577907 (5735759192, 5735759312, 5735759222) were **already approved** (22/24 Jun) → NOT open.
- SAP invoice 5735844555 on PO 0101608497 (Sodexo) recorded **approved 6 Jul 2026**.
- **The only genuinely open item:** the Radon 9.3E **sign-off** requested by Sorina Fota (~25 Jun, Teams).

## Test methodology (production-equivalent isolation)
1. **Isolated child instance** from a patched `server.js` copy (`_audittt-server.mjs`), Port **3118**, `AGENT_ZERO_SCAN_ENGINE=agency`, PID **25128**. Session vars `AGENCY_SESSION_ID` / `COPILOT_AGENT_SESSION_ID` stripped before launch.
   - `detectExistingInstance()` result → forced `null` (otherwise the 3000–3020 port scan would have found the user instance and exited).
   - `LOCK_FILE` → own `.agent-zero.audittt.lock` (real lock untouched).
   - `TASKS_FILE` / `JOBS_FILE` → **isolated copies** in `.audittt-tmp\` → the real `tasks.json` was **never opened** by the child.
2. **Exact user question** via Chat-API to the Circle task:
   `POST /api/tasks/proj-zurich-circle-hublcr/log` with
   `{"text":"Gibt es Action Items, bei denen ich aktiv werden muss? Ich scanne dazu meine Inbox der letzten zwei Wochen."}`
3. **Trivial question** via same endpoint: `{"text":"Summarize this task in two sentences"}`.
4. Latency measured from POST-202 to fast-job `completed` (Stage-1). Deep-job (`deep_verify`, `blocksTask:false`) polled to `completed` and its `agentFollowups` contribution read back.

## Measurements (evidence)

| # | Test | Job id | Stage-1 time | Stage-2? | Result |
|---|---|---|---|---|---|
| A1 | Circle Q — **cold** (first run after start) | `04b701f3` | **181.1s** | — | ❌ **FAILED** — fast timeout (180s), salvage failed, `Agency brain run timed out`, no answer, no conversation entry, no deep job queued |
| A2 | Circle Q — **warm** | `e2938b5d` | **120.1s** (brain 118.3s) | queued+completed | ⚠️ completed & content-correct, but **>90s MUST** (within <180s) |
| A2-deep | Circle Stage-2 deep_verify | `bb94dbb3` | — | ~**864s** ext. poll / brain `durationMs` 952102 (~15.9 min) | ✅ inside 25-min window; markers 5/5/0; confidence high |
| B | Trivial Q | `4ac0c6c0` | **47.2s** | **none** (`deepVerification.required=false`, no deep job) | ✅ **<90s, no Stage-2** |

### Latency criteria roll-up
- **Stage-1 <90s MUST:** ❌ never met for the Circle question (120.1s warm, 181.1s cold).
- **Stage-1 hard <180s:** ❌ breached on cold start (181.1s → salvage failure → no answer).
- **Trivial <90s w/o Stage-2:** ✅ 47.2s, `required=false`.
- **Stage-2 within 25 min:** ✅ ~14–16 min.

## Stage-1 content (Circle, sample A2, verbatim excerpt)
> Based on the task state and Fact Sheet, here's my fast answer. Let me do one quick inbox signal check.
> …
> - The project currently has **no open user actions and nothing on a waiting-list** — from project state (last verified 2026-12-01), `pmStatus.userActions` and `waitingOn` are both empty.
> - A quick inbox scan (23 Jun – 7 Jul 2026) surfaced **approval/confirmation request emails** … — signal only — unverified:
>   - MSApprovalNotifications — SAP Invoice 5735759192 on PO 0101577907, "pending your approval", 24 Jun — signal only — unverified.
>   - … Ask P2P — "REQUEST TO APPROVE ANIXTER PO 101577907", 25 Jun — signal only — unverified.
>   - MSApprovalNotifications — SAP Invoice 5735844555 on PO 0101608497, "pending your approval", 3 Jul — signal only — unverified (note: project state records this invoice as already approved on 6 Jul 2026 …).
> - Several "invoice approval notification" emails … indicate some of the above were **already completed** — signal only — unverified.
> Because these are notification emails, they cannot confirm whether an approval … is still open for you. Approval state must be checked in the system of record.
> Deep verification against MyApprovals started — I will update this conversation.

`agentExecution.deepVerification` = `{required:true, status:"running"→"completed", system:"MyApprovals", …}`.

**Stage-1 content verdict:** ✅ leads from project state, inline verification status on every sentence, honestly flags inbox items as "signal only — unverified", does **not** assert any resolved approval as open, and announces deep verification. Fully meets the Stage-1 content contract.

## Stage-2 deep verification (Circle, `agentFollowups[0]`, verbatim excerpt)
> **Deep verification result — MyApprovals (system of record), checked live on 7 Jul 2026**
> I signed into the MSApprovals portal (`msapprovals.microsoft.com`) as Martin Hämmerli and checked both the Pending and History views.
> **Bottom line: there is no approval action pending for you in the system of record — verified in MSApprovals ("No Pending Requests").**
> Every item that the inbox scan flagged … is now confirmed as already **Approved** in MSApprovals History … :
> | SAP Invoice 5735759192 · PO 0101577907 (Anixter) | Approved 24 Jun — verified in MSApprovals |
> | SAP Invoice 5735759312 · PO 0101577907 (Anixter) | Approved 24 Jun — verified in MSApprovals |
> | SAP Invoice 5735759222 · PO 0101577907 (Anixter) | Approved 22 Jun — verified in MSApprovals |
> | SAP Invoice 5735844555 · PO 0101608497 (Sodexo) | Approved 6 Jul — verified in MSApprovals (matches project state) |
> | MyOrder PO 101689105 (Anixter AV Hardware) | Approved 26 Jun — verified in MSApprovals |
> … the **Radon 9.3E official sign-off** that Sorina Fota requested in Teams (~25 Jun) is a Teams sign-off, not an MSApprovals item — signal only — unverified; I've flagged it for a Teams-thread check.
> **Answer to your question:** For approvals/invoices, you currently have **nothing to action** — verified in MSApprovals. The only possible open personal item is the Radon 9.3E sign-off …

**Stage-2 content verdict (grading criteria):**
- ✅ **No false open approvals:** all three PO 0101577907 invoices + 5735844555 confirmed **Approved** in the system of record; "no approval action pending."
- ✅ **Live portal check performed:** launched an **isolated** debug Edge instance (separate user-data-dir), WAM SSO, CDP read of MSApprovals Pending ("No Pending Requests") + History. This is the aspirational normal path AUDIT-BATCH-8 noted was previously only hedged — now actually executed.
- ✅ **Radon 9.3E sign-off named** as the only possible open personal item (Teams, not MSApprovals).
- ✅ **Verification status inline** throughout ("verified in MSApprovals", "signal only — unverified").
- ✅ Markers 5/5 applied, 0 held, confidence high; ran to `completed` inside the 25-min window.

## Trivial question (verbatim)
> The task covers the FY26 HUB LCR audio-visual program at Microsoft Zurich – The Circle, comprising the Radon room 9.3E AV rollout … and the dual MPR rooms 10.3D/10.3E refresh … — all from project state (last verified 2026-07-07). On the financials, SAP invoice 5735844555 (CHF 26,645.85, Sodexo) on PO 0101608497 … was recorded as approved on 6 Jul 2026 with no pending approvals remaining for Martin — from project state (last verified 2026-07-07), noting invoice/approval states shown here are signal only — unverified against the system of record.

`deepVerification.required=false`, 0 follow-ups, 47.2s. ✅ Answered from project state, no Stage-2, under 90s — this is the fast path working as designed.

## Root-cause analysis (why Stage-1 fails the <90s bar)
`buildTaskChatFastPrompt` (brain/task-chat.js) tells the fast stage: *"You may use WorkIQ only for at most two quick Microsoft 365 lookups when a fast signal is needed."* For a status/approval question — especially one that literally says "Ich scanne dazu meine Inbox" — the model performs a WorkIQ **inbox scan** inline (~40–90s each). Combined with agency-CLI + model latency this exceeds 90s warm (118.3s brain) and, on a **cold** start, exceeded the 180s fast timeout entirely; because <200 salvage bytes had been emitted, `runBrain` returned `ok:false` and the whole Stage-1 failed with **no answer**. The intended two-tier behavior would be to answer instantly from project state and defer *all* WorkIQ scanning to Stage-2. The trivial question (no WorkIQ needed) proves the fast path can hit 47s — so the latency leak is specifically the inline WorkIQ lookup in Stage-1.

**Fix direction (not applied — this is an audit):** make Stage-1 answer from project state only (no WorkIQ) for status/approval asks and always defer the inbox/portal work to Stage-2; or drop the fast WorkIQ hard limit to 0 and lower the fast timeout so a slow Stage-1 salvages a project-state-only answer well under 90s.

## Non-blocking observations
1. **`deepVerification.completedAt` mis-stamped.** For the Circle conversation, `completedAt=2026-07-07T08:41:25.965Z` equals the deep-job *start* (when Stage-1 finished / deep was queued), not the deep *end* (~08:55 UTC, per `durationMs=952102` and external polling). Display-only timestamp bug; the follow-up text, status, and markers are correct.
2. **Stage-2 exceeded Stage-1 by ~7–8×** in wall time (≈15 min vs 2 min), which is exactly the trade the two-tier design intends — heavy verification off the interactive path. Not a defect; noted for expectation-setting.

## Audit hygiene / safety
- **No** STOP/START scripts executed. **No** broad/name-based process kills.
- Only the **own** child PID **25128** to be terminated (after cmdline confirmation `node _audittt-server.mjs`). The child's brain agency sub-runs completed on their own.
- **Untouched:** user instance :3000 (PID 38084, uptime continuous 5964s→7600s across the run, `.agent-zero.lock` unchanged), the real `tasks.json` (SHA-256 `ED8AC58C…4541731` identical before and after; mtime `2026-07-07 10:19:15` unchanged — never opened), `jobs.json` (isolated copy used).
- **Removed cleanly after the run:** `_audittt-server.mjs`, `.audittt-tmp\`, `.agent-zero.audittt.lock`, and the `brain-work\runs\task-chat-*-{04b701f3,e2938b5d,bb94dbb3,4ac0c6c0}` run dirs. Git status shows only the two intended doc changes (AUDIT-TWOTIER.md, STATE.md).
