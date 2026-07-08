# OWA Attachment Fetch Helper

Batch 9D changed the required attachment discovery protocol. The default path is now a
targeted WorkIQ/M365 Copilot index question about the attachment content. WorkIQ can
surface attachment contents as indexed facts, but it does not deliver attachment bytes.
Mail MCPs deliver message bodies only. Index lag is possible, so record the WorkIQ
answer's retrieved/as-of date when available.

`brain/tools/owa-attachment.ps1` is retained as a legacy diagnostic byte helper. It is
not the required discovery path.

## Current Discovery Protocol

1. List attachment signals or metadata for the message.
2. Ask WorkIQ targeted questions about the specific attachment, such as "summarize the
   attached deck/PDF" or "list all dates, milestones, and scope items".
3. If WorkIQ returns concrete attachment-derived facts, cite those facts and set
   `attachmentsHandled:"yes(workiq-index)"`.
4. If WorkIQ cannot identify or summarize the attachment content, set
   `attachmentsHandled:"failed(<reason>)"` and emit review when task state may depend
   on the attachment.
5. Direct Graph or other attachment-byte retrieval remains an optional future path and
   is not implemented here. If a future read-only byte path actually reads attachment
   content, use `attachmentsHandled:"yes"` and cite file-derived facts.

## Safety Model

- Start a dedicated Microsoft Edge instance with `--remote-debugging-port` and a
  disposable `brain-work/owa-profiles/<runId>/` profile.
- Do not attach to the user's normal Edge profile or enumerate/kill existing Edge
  processes.
- Download only into `brain-work/attachments/<runId>/`.
- Close only the Edge process object started by this helper, then remove only that
  run's disposable profile directory.
- Use OWA only for read navigation, search, and attachment download. Do not send,
  delete, move, flag, categorize, or mark messages.

## Usage

Use this helper only for an explicit, safe byte-retrieval diagnostic. Do not use it as
the normal scan protocol.

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\brain\tools\owa-attachment.ps1 `
  -Subject "Project attachment message subject" `
  -Date "2026-07-06" `
  -Sender "Sender Name" `
  -RunId "scan-<runId>" `
  -Json
```

If a stable OWA item link is already known, pass `-MessageUrl "<owa-url>"` to skip
search-result discovery. The helper still validates that downloads stay under
`brain-work/attachments/<runId>/`.

The helper writes:

- `brain-work/attachments/<runId>/manifest.json`
- downloaded attachment files
- `<attachment>.txt` for each downloaded PDF when `pdftotext` or `pdf-parse` is
  available

When no visible attachment tile is available, the helper tries a same-session OWA REST
read from `outlook.office.com/api/v2.0` using the isolated Edge session. If OWA returns
401/403 or omits file bytes, the run fails with `failed(<reason>)`; do not infer
`attachmentsHandled:"yes"` from a paperclip or body text mentioning a deck.

`-ValidateOnly -Json` performs argument and path validation without starting Edge.
