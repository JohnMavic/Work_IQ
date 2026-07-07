BATCH9B: BLOCKED mail-MCP/WorkIQ/Graph did not provide a working Laith PDF/deck attachment read path

Live attachment probe against the real Laith Skeik message from 2026-07-06:

- Agency with explicit `--mcp mail` did not produce a usable noninteractive result for listing/downloading/reading the attachment.
- WorkIQ 1.0 `ask` found the context but returned only a Purview/DLP restriction notice and no attachment content.
- Microsoft Graph via `az rest` against `/me/messages` failed with `ErrorAccessDenied`, so attachments could not be listed or downloaded through Graph.
- The local pinned WorkIQ 0.2.8 path is present; after EULA acceptance, the non-TTY probe did not return attachment content.
- Best alternative: add a verified Graph delegated read path with Mail.Read attachment access, or implement an isolated Edge/OWA CDP routine that opens OWA in a throwaway debug profile and downloads the target attachment read-only.

Code fixes implemented despite the live attachment-path blocker:

- Processing ledger dispositions now require `attachmentsHandled: "yes" | "none" | "failed(<reason>)"`.
- If an enumerated message has attachments, the quality gate rejects `attachmentsHandled:"none"` and requires `yes` or `failed(<reason>)`.
- Reality Gateway deterministic checks now hold project markers with malformed processing ledgers before the model verdict can approve them.
- Agency Brain prompt now requires the per-message protocol: list attachments, read relevant ones, cite attachment facts, and record `attachmentsHandled`.
- Scan apply now runs a Batch 9 temporal pass before writing: stale unconfirmed dates in `pmStatus.planned`, `pmStatus.waitingOn`, or `lineItems` must be explicitly confirmed with fresh evidence or marked obsolete/superseded with reason and evidence.

Tests: `npm test` -> 145/145 passing.
