# Agent Zero — Custom Agent Instructions

> Version 4.0.0 · Agent architecture for the GitHub Copilot SDK Enterprise Challenge

Agent Zero uses the GitHub Copilot SDK to orchestrate multiple AI agent roles, each defined by a dedicated skill file. All agents communicate with Microsoft 365 via the Work IQ MCP server.

---

## Agent Roles

### 1. Discovery Agent (`SCAN_DISCOVERY_SKILL.md`)
- **Trigger:** User clicks "Scan Emails & Teams"
- **Purpose:** Scan email subjects and Teams messages from the last N days to identify action items
- **Behavior:** Subject-only scan (no body content), classifies messages as actionable or informational
- **Output:** New task cards with title, source, sender, and direct link
- **Duration:** ~30–60s total

### 2. Enrichment Agent (`ENRICH_SKILL.md`)
- **Trigger:** Automatically after Discovery phase
- **Purpose:** Extract full conversation content from each thread and generate summaries
- **Behavior:** 3-attempt keyword-based search strategy, temporal awareness (distinguishes current vs. historical information), ambiguity detection
- **Output:** Content summary, status recommendation, clarifying questions if uncertain
- **Duration:** ~60–180s per task (up to 300s for long Teams threads)

### 3. Update Check Agent (`UPDATE_CHECK_SKILL.md`)
- **Trigger:** Automatically after Enrichment phase (runs on every scan)
- **Purpose:** Detect new replies or activity in previously enriched threads
- **Behavior:** 3-attempt search anchored to `lastUpdateCheck` timestamp, reports only new content
- **Output:** Updated summary with new information, history log entry
- **Duration:** ~30–90s per task

### 4. Intelligent Search Agent (`SEARCH_SKILL.md`)
- **Trigger:** User creates a task via "Add Task" modal with an assignment
- **Purpose:** Goal-oriented search across M365 communications to answer specific questions
- **Behavior:** 3-attempt strategy with self-assessment, confidence levels (high/medium/low/none), bilingual keywords (user language + English), relevance filtering
- **Output:** Direct answer with confidence badge, search attempt details, source references
- **Duration:** ~30–120s per search

---

## Agent Architecture

```
┌─────────────────────────────────────────┐
│          Express Server (server.js)      │
│                                          │
│  ┌──────────────┐  ┌──────────────────┐ │
│  │ Skill Files   │  │ Copilot SDK      │ │
│  │ (docs/)       │→ │ Session Manager  │ │
│  └──────────────┘  └────────┬─────────┘ │
│                              │ stdio     │
│                    ┌─────────┴─────────┐ │
│                    │   Work IQ MCP     │ │
│                    │ (@microsoft/workiq)│ │
│                    └─────────┬─────────┘ │
└──────────────────────────────┼───────────┘
                               │ Microsoft Search API
                    ┌──────────┴──────────┐
                    │   Microsoft 365     │
                    │ Email · Teams · Cal  │
                    └─────────────────────┘
```

### Session Model
- Each API call creates a **fresh Copilot SDK session** with Work IQ as MCP server
- Sessions are independent — no shared state between agent invocations
- Skill files are loaded at server startup and injected as system prompts
- The agent receives task-specific context (title, sender, link, timestamps) alongside the skill instructions

### Safety Mechanisms
- **Ambiguity handling:** Agents flag uncertain information with `needs-review` status and present clarifying questions to the user
- **Temporal awareness:** Agents distinguish current from historical information using discovery dates and last-check timestamps
- **3-attempt search:** Agents try progressively broader search strategies before reporting failure
- **Self-assessment:** Search agents evaluate whether their results actually answer the user's question (not just keyword matches)
- **Hallucination prevention:** Agents are instructed to say "I could not find this" rather than fabricate information

---

## Skill File Locations

| Skill File | Agent Role | Path |
|---|---|---|
| `SCAN_DISCOVERY_SKILL.md` | Discovery (Phase 1) | `docs/` |
| `ENRICH_SKILL.md` | Enrichment (Phase 2) | `docs/` |
| `UPDATE_CHECK_SKILL.md` | Update Check (Phase 3) | `docs/` |
| `SEARCH_SKILL.md` | Intelligent Search | `docs/` |
| `SCAN_SKILL.md` | Legacy scan (fallback) | `docs/` |
| `LOG_WORK_SKILL.md` | Legacy work logging (fallback) | `docs/` |

---

## MCP Server Configuration

See `mcp.json` in the project root for the Work IQ MCP server configuration.
