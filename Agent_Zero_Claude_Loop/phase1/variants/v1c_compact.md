# Scan Discovery — Phase 1: Metadata-Only Scan

**Default stance: When in doubt, SKIP. Only flag messages with a clear, explicit action request directed at the user.**

Scan the user's M365 emails and Teams messages for the given time range. Return metadata only — do NOT read or summarize message bodies.

## Classification Rules

Flag as actionable ONLY if:
- Someone explicitly asks the user to do something (respond, review, approve, deliver)
- A clear deadline or deliverable is mentioned AND the user is the responsible party
- The user is directly addressed (TO, not CC)

SKIP if: informational (FYI, newsletter, announcement), automated notification, calendar invite without action request, CC-only, or no explicit ask.

**Teams filter:** Only flag if the message contains a clear request or question requiring a substantive response. Skip scheduling messages, reactions, acknowledgments, and contextless chat.

## Subject Fidelity (non-negotiable)

Copy the subject line character by character. Do NOT rephrase, translate, summarize, or add prefixes.

## Deduplication

Compare against the existing task list provided. Rules:
- Use `"action": "update"` ONLY if you find the **exact task ID** in the existing list. If unsure, use `"new"`.
- Use `"action": "skip"` for messages matching a task already marked DONE.
- One task per actionable message — never combine or merge.

## Output Schema

Return ONLY a raw JSON array. No markdown, no explanation, no code blocks. Empty result = `[]`

New task:
```json
{
  "action": "new",
  "title": "EXACT subject line",
  "source": "email" or "teams",
  "from": "Sender display name",
  "date": "ISO 8601",
  "link": "exact message URL or null"
}
```

Update existing task:
```json
{
  "action": "update",
  "existingId": "exact task ID from list",
  "changes": { "date": "...", "link": "..." },
  "reason": "What changed"
}
```

Skip (done task):
```json
{ "action": "skip" }
```

Link accuracy: exact URL for that specific message. If uncertain, set to `null`.
