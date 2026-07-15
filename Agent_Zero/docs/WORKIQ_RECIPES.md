# Work IQ Recipes — Verified Success Patterns

**Purpose:** Collection of Work IQ CLI invocations that have been **manually verified** to work against `martih@microsoft.com` (Microsoft Corporate Tenant). Each recipe documents the exact command, what came back, and *why* it worked.

This file is **not** consumed by Agent Zero at runtime — it is for humans (Martin + engineers) to copy-paste verified patterns. The primary scan engine's runtime prompt is [`AGENCY_BRAIN_SCAN_SKILL.md`](AGENCY_BRAIN_SCAN_SKILL.md); [`SEARCH_SKILL.md`](SEARCH_SKILL.md) is the runtime prompt only for the legacy/manual per-task search ("Log Work") route (`POST /api/tasks/:id/log`), not for the default scan.

---

## Prompt Anatomy — The 5 Building Blocks

Every reliable Work IQ prompt should contain:

| # | Building block | Why |
|---|---|---|
| 1 | **Scope / source anchor** ("inbox", "Microsoft 365 profile", "organizational hierarchy") | Tells Work IQ which Graph endpoint to consult |
| 2 | **Specific request** (not vague — e.g. "direct manager", "emails received in the last 3 hours") | Eliminates interpretation room |
| 3 | **Output schema** ("Return: name, title, email") | Forces structured response |
| 4 | **Negative case** ("If nothing found, say so explicitly") | Prevents hallucinations |
| 5 | **Time anchor when relevant** ("now is 2026-05-13 23:00 CEST") | LLM does not reliably know "now" |

---

## Recipe 1 — Direct Manager Lookup

**Use case:** Retrieve the user's direct manager from Microsoft 365 organizational data.

**Verified:** 2026-05-14, account `martih@microsoft.com`.

### Working command (PowerShell)

```powershell
workiq ask -q "Look up my organizational profile in Microsoft 365. Return only the name, job title, and email address of my direct manager (the person I report to)."
```

### Expected response shape

Markdown with:
- **Name** — full display name
- **Job title** — string from AD
- **Email address** — UPN
- Footer Office-Search link (citation)

### Why it works

| Building block | In this prompt |
|---|---|
| Scope anchor | "Look up my **organizational profile in Microsoft 365**" |
| Specific request | "my **direct manager** (the person I report to)" — disambiguates "manager" |
| Output schema | "Return only the **name, job title, and email address**" |
| Negative case | Implicit (single deterministic record from AD — no ambiguity expected) |
| Time anchor | Not needed (AD profile is "now"-state) |

### Failure modes observed

- **Transient Work IQ backend error** on the first attempt of the session — the CLI returned `Error: Unexpected error: Server error` and offered to generate a debug-share-link. A simple retry with a slight rephrasing succeeded immediately. **The prompt was not the problem** — Work IQ backend was momentarily unavailable. Retry-on-server-error is the right strategy here, not prompt rewriting.

### Extension ideas

- "Return my full reporting chain up to the CVP level" — pull multiple levels
- "Who are my direct reports?" — reverse the lookup
- "Export this as a vCard / contact card" — Work IQ offered this proactively

---

## Recipe 2 — Positive News in Inbox (Last N Hours)

**Use case:** Scan the last few hours of inbox for uplifting / positive emails.

**Verified:** 2026-05-13, account `martih@microsoft.com`.

### Working command (PowerShell)

```powershell
workiq ask -q "Search my inbox for emails received in the last 3 hours that contain positive news, good news, wins, achievements, congratulations, success, approvals, or uplifting content. For each match, return: subject, sender (name and email), received time, and a 1-2 sentence summary of why it's positive. If nothing positive is found, say so explicitly. Only consider emails received in the last 3 hours (now is 2026-05-13 23:00 CEST)."
```

### Why it works

| Building block | In this prompt |
|---|---|
| Scope anchor | "**Search my inbox** for emails received in the last 3 hours" |
| Specific request | Broad semantic synonyms: "positive news, good news, wins, achievements, congratulations, success, approvals, uplifting content" — Work IQ uses Microsoft Search API (keyword-based, **not** semantic), so synonyms must be enumerated explicitly |
| Output schema | "Return: **subject, sender, received time, 1-2 sentence summary**" |
| Negative case | "If nothing positive is found, **say so explicitly**" |
| Time anchor | "**now is 2026-05-13 23:00 CEST**" — required because LLM defaults are unreliable |

### Caveats

- Self-sent emails to your own inbox **are** included (e.g. your `Three Positive Things` script). Add `Exclude self-sent (from martih@microsoft.com)` to the prompt if you want them filtered.
- Notification-noise (LinkedIn, etc.) is included unless you exclude it.

---

## General Operational Notes

### CLI mechanics

- **Flag:** Use `-q` (short form) or `--question`. Bare positional argument is **rejected** by the CLI.
- **Quoting:** Always wrap the question in double quotes from PowerShell.
- **Verbose:** Add `-v` to get the conversation ID for support tickets.
- **Files as context:** Use `-f <SharePoint/OneDrive-URL>` to attach a document.

### Latency expectations

| Query type | Typical latency |
|---|---|
| Profile / AD lookup | 3–8 s |
| Inbox keyword scan (small window) | 5–15 s |
| Inbox scan with summarisation (10+ hits) | 30–90 s |
| Teams thread retrieval (long thread) | 60–240 s |

### When to retry vs. rewrite

| Symptom | Action |
|---|---|
| `Server error` / `Unexpected error` | **Retry as-is** (transient backend) |
| Returns hit count but no details (Sent Items) | Known limitation — switch to inbox search or accept |
| Returns nothing where you expect a match | Rewrite: add synonyms, widen time window, switch from "today" to "last 7 days" |
| Hallucinated content (fabricated subjects) | Rewrite: tighten output schema, add "if nothing found, say so" |

### Known limitations (Microsoft Search API backbone)

- Sent Items return hit-count only, no message details (GitHub Issue #55, `microsoft/work-iq-mcp`)
- Some inbox emails are not indexed (Focused-Inbox filtering or indexing delay)
- Date filters are **approximate** — never narrow to a single day; always search ≥ 7 days for "today / heute / gerade" and filter client-side
- Mail.Read scope is **not** consumed (Search API is used instead) — no admin consent needed

---

## Adding New Recipes

When a new Work IQ pattern proves successful in real usage:

1. Add a new `## Recipe N — <Use case>` section below
2. Include: working command, response shape, building-block breakdown, failure modes
3. Verify the recipe **once more** before committing — Work IQ behaviour evolves
4. Date-stamp the verification

---

*Last updated: 2026-05-14*
