BATCH9D: OK WorkIQ attachment-index proof: Microsoft Seestrasse - August Works.pdf contains "Planned PIS - August 31st" / 31 Aug 2026 and scope Full office recabling; Cable room optimisation; Security System renewal; AV life cycle renewal

Batch 9D corrected the Batch 9C attachment conclusion. The live evidence shows that
WorkIQ can surface attachment contents through the M365 Copilot index when asked a
targeted attachment question. It does not provide attachment bytes.

Live proof:

- Runner: headless `agency copilot` through the repo `runBrain` wrapper.
- Counters: exit 0, 1 tool start, 1 WorkIQ call, duration about 69 s.
- Question asked to WorkIQ:
  `Summarize the attached deck/PDF of Laith Skeik's email from 6 Jul 2026 in the thread "Confirmation: Temporary Workspace Setup at Seestrasse" about the Seestrasse August closure. List all dates, milestones, and scope items it contains. Specifically include whether the attachment contains a PIS date of 31 Aug 2026 and the scope list. Mention the as-of timestamp/date of your WorkIQ answer if available.`
- Answer excerpt:
  `Attachment identified as "Microsoft Seestrasse - August Works.pdf" (last modified 7 Jul 2026). Dates/milestones: Office closed 17 Aug 2026 - 28 Aug 2026; Workstations Move 17-18 Aug; Security Renewal, Recabling, AV Renewal, Cable Room Optimization during closure window; Planned PIS - 31 Aug 2026 ("Planned PIS - August 31st"). Scope: Full office recabling; Cable room optimisation; Security System renewal; AV life cycle renewal. Temporary workstations set up in the storage room. As-of: search result retrieved 8 Jul 2026.`

Implemented:

- Corrected Brain Learnings: WorkIQ surfaces attachment CONTENTS via the M365 Copilot
  index; ask targeted questions about the attachment, do not expect bytes, and state the
  as-of/index-lag caveat.
- Updated the scan discovery protocol: messages with attachments now require a targeted
  WorkIQ attachment-content probe first. Success uses
  `attachmentsHandled:"yes(workiq-index)"` with cited attachment facts; failure uses
  `attachmentsHandled:"failed(<reason>)"`.
- Updated the deterministic ledger validator and Reality Gateway prompt for
  `yes(workiq-index)`. Plain `yes` remains valid only for direct read-only byte/content
  paths that actually read the attachment.
- Removed `owaAttachmentHelper` from the scan bootstrap so normal scans no longer route
  to OWA-CDP by default.
- Updated OWA helper docs: retained as legacy diagnostic byte fallback only. Graph or
  other byte retrieval is documented as an optional future path and was not built.
- Updated Task Chat and Deep Verification prompts to use the same WorkIQ-index
  attachment rule.
- Updated Batch 9 tests for the new `attachmentsHandled` values and added guard coverage
  that the false WorkIQ/Graph learning is gone.

Tests:

- `node --test tests/unit/batch9.mjs` -> 8/8 passing.
- `npm test` -> 146/146 passing.

Safety:

- Ran `WHO-IS-AGENT-ZERO.bat` before process work. It reported two `server.js`
  instances and no Agent Zero WorkIQ child; no STOP/START or broad process kill was
  performed.
- The live proof used only short-lived Agency child processes. Existing Agent Zero
  server processes, `tasks.json`, and user sessions were not touched.
