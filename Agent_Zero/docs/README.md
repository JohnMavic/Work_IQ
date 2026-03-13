# Agent Zero — Solution Documentation

> GitHub Copilot SDK Enterprise Challenge · Q3 FY26

---

## Problem Statement

Knowledge workers at Microsoft spend significant time manually scanning emails and Teams messages to identify action items, track ongoing threads, and stay current on conversations. This reactive approach leads to missed deadlines, lost context, and hours spent reading through messages that may not even require action.

The core challenge: **email is designed for reading, not for acting.** There is no built-in mechanism to automatically extract, prioritize, and monitor action items across Microsoft 365 communications.

---

## Solution

**Agent Zero** is a personal AI-powered action-item tracker that transforms passive email/Teams consumption into active task management. Built on the **GitHub Copilot SDK** with **Work IQ** as MCP server, it scans Microsoft 365 communications, extracts content summaries, and continuously monitors threads for updates — all running locally.

### How It Works

1. **Discovery** — AI scans email and Teams subjects, identifies messages requiring action, creates task cards
2. **Enrichment** — AI extracts full conversation content via Work IQ, generates summaries with temporal awareness
3. **Update Check** — AI detects new replies since the last check, updates summaries with only new information
4. **Intelligent Search** — Users can ask specific questions about their communications; AI searches with self-assessment and confidence levels
5. **Correction Verification** — When users dispute stored information, AI verifies claims against M365 evidence before applying changes

### Key Differentiators

- **Goal-oriented search** — Agents evaluate whether results actually answer the question, not just match keywords
- **Temporal awareness** — Agents distinguish current from historical information using discovery dates
- **Evidence-based corrections** — When users say information is wrong, AI searches M365 for evidence before changing anything. Truth hierarchy: newest messages > older messages > history > user claims. Users retain absolute veto right.
- **Claude Opus 4.6 for intent classification** — The most capable model handles nuanced intent detection, especially distinguishing corrections from updates
- **Ambiguity handling** — When uncertain, agents ask clarifying questions instead of guessing
- **Hallucination prevention** — Agents are instructed to report failure honestly rather than fabricate information
- **Three-attempt strategy** — Progressively broader search approaches before giving up

---

## Project Structure

Agent Zero is a lightweight two-file application (`server.js` + `index.html`) — intentionally kept minimal to reduce complexity and make the codebase easy to audit. Rather than introducing a `/src` or `/app` directory for just two files, the application code lives directly in the project root alongside its configuration:

```
Agent_Zero/
├── server.js              # Express backend — API, Copilot SDK, scan orchestration
├── index.html             # Single-page frontend — dark-themed task dashboard
├── package.json           # Dependencies (@github/copilot-sdk, express, @microsoft/workiq)
├── AGENTS.md              # Custom agent instructions (4 agent roles)
├── mcp.json               # MCP server configuration for Work IQ
├── START-AGENT-ZERO.bat   # Windows launcher (auto-starts server + browser)
├── docs/                  # Documentation, skill files, architecture
│   ├── README.md          # This file — solution documentation
│   ├── ARCHITECTURE.md    # Detailed technical architecture
│   ├── CHANGELOG.md       # Version history (v1.0 → v2.6)
│   └── *.md               # 7 skill files (scan, enrich, search, correct, etc.)
├── Specifactions/         # Product specification
├── Images/                # Branding images
└── presentations/         # Demo deck (PowerPoint)
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Browser (index.html)                    │
│  Dark-themed SPA · Filter bar · Task cards · Agent panels   │
└────────────────────────────┬────────────────────────────────┘
                             │ HTTP (localhost:3000)
┌────────────────────────────┴────────────────────────────────┐
│                    Express Server (server.js)                │
│  REST API · Scan orchestration · Skill file loader          │
└────────┬───────────────────────────────┬────────────────────┘
         │ Copilot SDK (stdio)           │ fs (read/write)
┌────────┴────────────┐         ┌────────┴────────────┐
│   Work IQ MCP       │         │   tasks.json        │
│   @microsoft/workiq │         │   Local file store   │
└────────┬────────────┘         └─────────────────────┘
         │ Microsoft Search API
┌────────┴────────────────────────────────────────────────────┐
│              Microsoft 365 (Emails · Teams · Calendar)       │
└─────────────────────────────────────────────────────────────┘
```

**Data flow:** Browser → Express → Copilot SDK → Work IQ MCP → Microsoft 365 → back up the chain.

### Technology Stack

| Component | Technology | Version |
|---|---|---|
| Runtime | Node.js | v22.15.0 |
| Web framework | Express | 5.2.1 |
| AI orchestration | **@github/copilot-sdk** | 0.1.25 |
| M365 data access | **@microsoft/workiq** (MCP) | 0.2.8 |
| Frontend | Single-file HTML/CSS/JS | — |
| Data storage | Local JSON file | — |

---

## Prerequisites

- **Node.js** v18+ — [nodejs.org](https://nodejs.org/)
- **Work IQ** — `npm install -g @microsoft/workiq` (v0.2.8+)
- **GitHub Copilot** — active subscription for the Copilot SDK
- **Microsoft 365 account** — Work IQ needs access to your M365 tenant

## Setup & Deployment

```bash
# Clone the repository
git clone https://github.com/JohnMavic/Work_IQ.git
cd Work_IQ/Agent_Zero

# Install dependencies
npm install

# Accept Work IQ EULA (first time only)
workiq accept-eula

# Start the server
node server.js
# Or double-click START-AGENT-ZERO.bat on Windows
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Deployment Model

Agent Zero runs **locally** by design. All data stays on the user's machine — the only external communication is between the Copilot SDK and Microsoft 365 via Work IQ. This architecture ensures:
- No sensitive data leaves the local environment
- No cloud infrastructure required
- No additional authentication beyond existing M365 credentials
- Full user control over what is scanned and stored

---

## Business Value Proposition

### For Individual Knowledge Workers
- **Save 30–60 minutes daily** by eliminating manual email/Teams scanning
- **Never miss an action item** — AI identifies tasks humans might overlook
- **Stay current without effort** — automatic update checks on every scan

### For Enterprise Adoption
- **Zero infrastructure cost** — runs locally, no cloud deployment needed
- **Works with existing M365** — leverages current email and Teams, no migration
- **Copilot SDK showcase** — demonstrates how enterprises can build custom AI agents on top of the Copilot platform
- **Work IQ integration** — proves the value of MCP-based M365 access for custom tools

---

## Responsible AI (RAI) Notes

### Data Privacy & Retention
- All task data is stored locally in `tasks.json` — never uploaded to external services
- Work IQ accesses only the authenticated user's own M365 data via Microsoft Search API
- No data is shared with third parties beyond the Copilot SDK and Work IQ
- `tasks.json` is gitignored to prevent accidental exposure of personal data
- **Automatic data cleanup:** Completed tasks are automatically deleted from the local machine after a configurable retention period (default: 3 days). This ensures personal communication data does not accumulate indefinitely and minimizes the data footprint on the user's device

### Transparency & Explainability
- Every agent action is logged in the task history with timestamps, search keywords, and duration
- Search agents report confidence levels (high/medium/low/none) so users can assess reliability
- Search attempt details are visible in the UI, showing exactly what the agent searched for

### Hallucination Mitigation
- Agents are explicitly instructed to report "I could not find this" rather than fabricate information
- Self-assessment mechanism: agents evaluate whether their results actually answer the question
- `needs-review` status with clarifying questions when the agent is uncertain
- Temporal awareness prevents agents from presenting historical information as current

### Human Oversight
- Users can review, edit, and override all AI-generated content
- Ambiguity panel presents agent questions for user resolution
- **Correction verification:** when users dispute stored information, AI verifies against M365 evidence before changing anything. Users retain absolute veto right to override the agent's verdict.
- No automated actions are taken without user initiation (scan must be triggered manually)
- All task status changes require explicit user interaction

### Limitations
- Work IQ uses Microsoft Search API, which may not index all emails immediately (Focused Inbox filtering, indexing delays)
- Enrichment can take up to 300 seconds for long Teams threads
- Sent Items search has known limitations (GitHub Issue #55 on microsoft/work-iq-mcp)

---

## Related Documentation

- [Architecture Details](ARCHITECTURE.md)
- [Changelog](CHANGELOG.md)
- [Product Specification](../Specifactions/AGENT_ZERO_SPEC.md)
- [Agent Instructions](../AGENTS.md)
- [MCP Configuration](../mcp.json)
