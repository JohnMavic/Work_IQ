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
