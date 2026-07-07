BATCH9C: BLOCKED OWA-CDP reached the real thread but no PDF/deck bytes were retrieved; further UI attempts stopped after OWA changed read/unread state

Batch 9C implementation completed the reusable attachment route but did not produce
the requested live PIS proof.

Implemented:

- Added `brain/tools/owa-attachment.ps1`.
- The helper validates `RunId`, requires `BrainWorkDir` to resolve to `brain-work`,
  and restricts downloads to `brain-work/attachments/<runId>/`.
- It launches a dedicated Edge debugging instance with a disposable
  `brain-work/owa-profiles/<runId>/` profile and cleans up only that process/profile.
- It searches OWA by subject/date/sender, can use `-MessageUrl`, writes
  `manifest.json`, and extracts PDF text through local `pdftotext` when a PDF is
  downloaded.
- It includes an OWA same-session REST fallback, but the live probe returned 401 for
  `outlook.office.com/api/v2.0/me/messages/...`.
- Added `docs/OWA_ATTACHMENT_FETCH.md`, Scan-skill protocol text, and Brain Learnings
  for the OWA attachment fallback and the OWA auto-mark-read caveat.
- Discovery protocol now says: try mail/Teams attachment APIs first; then OWA-CDP;
  set `attachmentsHandled:"yes"` only after reading attachment content; otherwise use
  `failed(<reason>)`.

Live probe against the real Laith Skeik thread:

- Target: `Confirmation: Temporary Workspace Setup at Seestrasse`, Laith Skeik,
  2026-07-06 18:45.
- OWA-CDP successfully reached Outlook with the isolated Edge profile and opened the
  real conversation.
- Visible evidence confirmed the real thread context: Belinda's 2026-07-07 reply
  quotes Laith's 2026-07-06 18:45 message saying he put out a deck for the August
  office-closure communication.
- The OWA UI exposed a conversation paperclip, but no visible PDF/PPTX/DOCX/XLSX
  attachment tile or download control appeared for the opened view.
- OWA REST fallback from the same browser session returned 401 for the message lookup,
  so attachment bytes were not retrieved.
- No PDF text was extracted and no PIS date was proven.
- The inbox unread counter changed during OWA opening, so further UI attempts were
  stopped to preserve the read-only safety requirement.

Tests:

- `node --test tests/unit/batch9.mjs` -> 8/8 passing.
- `npm test` -> 146/146 passing.
