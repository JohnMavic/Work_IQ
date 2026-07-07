# OWA Attachment Fetch Helper

`brain/tools/owa-attachment.ps1` is the read-only fallback when mail/Teams MCPs expose
that a message has source attachments but cannot download or read them.

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

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\brain\tools\owa-attachment.ps1 `
  -Subject "Confirmation: Temporary Workspace Setup at Seestrasse" `
  -Date "2026-07-06" `
  -Sender "Laith Skeik" `
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

## Discovery Protocol

1. Prefer mail/Teams MCP attachment APIs.
2. If those APIs cannot download/read an attachment that may affect task state, run
   the OWA helper with the message subject, date, sender if known, and the current
   scan `runId`.
3. Read `manifest.json` and the extracted text files from `brain-work/attachments/<runId>/`.
4. Set `attachmentsHandled:"yes"` only after the relevant attachment content was read.
5. Set `attachmentsHandled:"failed(<reason>)"` and emit `NEEDS_REVIEW` when the helper
   cannot find, download, or extract the attachment.
