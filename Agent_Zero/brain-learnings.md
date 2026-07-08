# Agent Zero Brain Learnings

Curated persistent operating memory for Agent Zero's Agency Brain. Entries are general
principles, reusable patterns, or stable facts. They must not contain task state,
customer secrets, credentials, or one-off project facts.

## 2026-07-07 principle: signals-vs-systems-of-record
Category: principle
Evidence: Batch 8 seed from user-approved gremium prompt.
Text: Signals vs. systems of record: notification emails for approvals or tickets are signals; the authoritative state lives in the system of record such as MyApprovals, IcM, SAP, or the relevant portal. Never assert approval or ticket state from mail alone. Verify in the system, or state explicitly that it is unverified via the system of record.

## 2026-07-07 fact: workiq-is-lossy-index
Category: fact
Evidence: Batch 8 seed from user-approved gremium prompt.
Text: WorkIQ can hallucinate, omit messages, and compress away decisive details. Treat WorkIQ as a lossy index for discovery and targeting, not as the highest authority for current state.

## 2026-07-07 principle: verify-or-unverified
Category: principle
Evidence: Batch 8 seed from user-approved gremium prompt.
Text: Never guess confidently. If a state, owner, approval, ticket, or deadline cannot be verified from the authoritative source, say that it is unverified and avoid converting the guess into task state.

## 2026-07-07 pattern: edge-cdp-system-of-record-check
Category: pattern
Evidence: Imported generically from the user's agency memory pattern edge-cdp-automation.md.
Text: For Microsoft-internal portals protected by Entra ID when a normal browser MCP is unavailable, use a dedicated Microsoft Edge remote-debugging instance rather than controlling the user's active browser. Prefer an isolated debugging profile that can use Windows/WAM SSO, wait for SSO redirects to finish, list CDP tabs from localhost, connect to the target page WebSocket, and use CDP Runtime.evaluate/Page.navigate to read portal state. For approval portals, check both Pending and History or completed views before declaring an approval open, approved, rejected, or absent. Close only the debug connection or debug browser that this run opened.

## 2026-07-07 fact: myapprovals-object-classes
Category: fact
Evidence: Batch 8B user correction from portal-verified MyApprovals behavior.
Text: MyApprovals hosts two object classes: MyOrder PO approvals (PO numbers) and Modern Invoice approvals (GUID request ids). A task status list tracking only PO numbers does NOT cover invoice approvals; never infer invoice approval state from PO bookkeeping.

## 2026-07-07 principle: when-two-sources-appear-to-conflict-on-a-binary-status-resolved-
Category: principle
Evidence: Live inbox/Teams checks repeatedly resolve apparent status conflicts into partial states rather than one side being wholly correct.
Text: When two sources appear to conflict on a binary status (resolved vs blocked), live verification often reveals a split state where one sub-component is complete and another remains blocked; capture both sub-states instead of forcing a single resolved/blocked verdict.

## 2026-07-07 principle: attachments-are-source-evidence
Category: principle
Evidence: Batch 9D corrected the attachment protocol after a live WorkIQ probe returned PDF/deck facts from the M365 Copilot index.
Text: For mail or Teams discovery, relevant attachments such as PDF, DOCX, and XLSX files are source evidence. Ask targeted WorkIQ questions about the attachment content before changing task state; if content cannot be surfaced, surface the gap instead of silently ignoring it.

## 2026-07-08 fact: workiq-index-surfaces-attachment-contents
Category: fact
Evidence: Batch 9D live WorkIQ probe returned attachment-only milestone and scope facts from an indexed deck/PDF.
Text: WorkIQ surfaces attachment CONTENTS via the M365 Copilot index — ask targeted questions about the attachment (summarize/list facts). It does not deliver attachment bytes; mail-MCP delivers bodies only. Index lag possible — state the as-of caveat.

## 2026-07-07 pattern: owa-cdp-attachment-byte-fallback
Category: pattern
Evidence: Batch 9C built and tested an OWA-CDP byte helper, but Batch 9D superseded it as the default because WorkIQ can surface attachment contents through the M365 Copilot index and OWA UI navigation may mutate read state.
Text: OWA-CDP attachment byte retrieval is a legacy diagnostic fallback, not the discovery default. Prefer targeted WorkIQ attachment-content probes; use UI or byte-download fallbacks only when explicitly needed, read-only, and safe, and record failure instead of continuing if the path would mutate mail state.

## 2026-07-07 fact: owa-can-auto-mark-read
Category: fact
Evidence: Batch 9C live OWA-CDP probe observed the inbox unread counter change after opening a target message in OWA.
Text: OWA can automatically change read/unread state when an unread message is opened through the UI. Attachment fallback must prefer non-mutating attachment APIs or already-open/read evidence; if continuing would change mail state, stop and record the attachment as failed instead of trying more UI clicks.
