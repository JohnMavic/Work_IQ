# Agent Zero

> Version 2.2.0 · A personal AI-powered action-item tracker for Microsoft 365

**Author:** Martin Hämmerli · [martih@microsoft.com](mailto:martih@microsoft.com)

Scans your emails and Teams messages, extracts content summaries, and monitors threads for updates — all locally, all AI-driven.

## Quick Start

**Double-click** `START-AGENT-ZERO.bat` — starts the server and opens the browser.

**Or manually:**
```powershell
cd E:\Work_IQ\Agent_Zero
node server.js
```
Then open [http://localhost:3000](http://localhost:3000).

## Prerequisites

- **Node.js** v18+ — [nodejs.org](https://nodejs.org/)
- **Git** — [git-scm.com](https://git-scm.com/) (or `winget install Git.Git`)
- **Active GitHub Copilot subscription** — [Copilot plans](https://github.com/features/copilot/plans)
- **M365 account** — Work IQ needs access to your Microsoft 365

## Architecture Overview

Agent Zero uses two independent stacks — one for AI (left) and one for M365 data access (right). Each stack has three layers: the library you import in code, the engine that runs in the background, and the cloud API it connects to.

```
┌───────────────────────────────────────────────────────────────────┐
│  Agent Zero (server.js — Express on localhost:3000)                │
│                                                                   │
│  YOUR CODE IMPORTS (npm dependencies in package.json)             │
│  ┌──────────────────────┐    ┌──────────────────────────────────┐ │
│  │ @github/copilot-sdk  │    │ @microsoft/workiq               │ │
│  │ (TypeScript library) │    │ (Node.js library + CLI)         │ │
│  └────────┬─────────────┘    └────────┬─────────────────────────┘ │
│           │ starts internally         │ spawned by SDK as          │
│           │ via JSON-RPC              │ stdio subprocess           │
│  BACKGROUND ENGINES (installed automatically as sub-dependencies) │
│  ┌────────▼─────────────┐    ┌────────▼─────────────────────────┐ │
│  │ @github/copilot      │    │ workiq mcp                      │ │
│  │ = copilot.exe         │    │ (MCP protocol over stdio)       │ │
│  │ (native binary)      │    │                                  │ │
│  └────────┬─────────────┘    └────────┬─────────────────────────┘ │
└───────────┼──────────────────────────┼──────────────────────────-─┘
            │ HTTPS                    │ Microsoft Graph API
            │                          │
   GitHub Copilot API          Microsoft 365 (your tenant)
   (AI model in the cloud)    (your emails, Teams, calendar)
```

### Dependency Chain — Why So Many Packages?

When you run `npm install`, this is what actually gets installed:

```
package.json says:
  "@github/copilot-sdk"  ──depends on──▶  "@github/copilot"  ──depends on──▶  copilot.exe
  "@microsoft/workiq"                                                          (native binary
  "express"                                                                     for your OS)
  "uuid"
```

The SDK is a thin TypeScript wrapper. The actual AI engine is `copilot.exe` — a compiled native binary (platform-specific: `copilot-win32-x64`, `copilot-darwin-arm64`, etc.) that the SDK starts as a background process and controls via JSON-RPC. You never call `copilot.exe` directly — the SDK handles everything.

| Component | Layer | Technical | In Plain English | Auth |
|---|---|---|---|---|
| **Copilot SDK** (`@github/copilot-sdk`) | Library | Imported in `server.js` via `import { CopilotClient } from '@github/copilot-sdk'`. Provides the `CopilotClient` class. This is the only Copilot package referenced in Agent Zero's code. Installed as a direct dependency via `npm install`. | The remote control for the AI. This npm package is imported in `server.js` and provides the commands that let Agent Zero start AI sessions, ask questions, and receive answers. You only work with this package — everything else happens invisibly in the background. | — |
| **Copilot CLI** (`@github/copilot` → `copilot.exe`) | Engine | Automatically installed as a sub-dependency of the SDK. Contains a native binary (`copilot.exe` on Windows, platform-specific via `@github/copilot-win32-x64` etc.). The SDK starts this binary internally and communicates with it via JSON-RPC. It handles GitHub OAuth, token management, and the actual HTTPS connection to GitHub's Copilot API. Never called directly in Agent Zero's code. | The engine under the hood. When the SDK starts an AI session, it launches this .exe file in the background. It handles the GitHub login, manages access tokens, and talks to the AI model in the cloud. You never see it directly — it is automatically installed alongside the SDK and controlled by it. | GitHub OAuth — triggered by the SDK on first use. A one-time device code prompt appears in the terminal. |
| **GitHub Copilot API** | Cloud | The remote AI service hosted by GitHub. Receives prompts from `copilot.exe`, runs them through the AI model, and returns structured responses. Requires an active GitHub Copilot subscription. | The AI brain in the cloud. This is where the actual language model runs — it analyzes your emails, writes summaries, and answers questions. You need a GitHub Copilot subscription for Agent Zero to access it. | Active GitHub Copilot subscription required. |
| **Work IQ** (`@microsoft/workiq`) | Library | Installed as a local npm dependency (`package.json`) and optionally as a global CLI. Provides the `workiq` command used to start MCP servers and to run the initial EULA/auth setup. | The bridge to your Microsoft 365. This npm package is installed and provides the `workiq` command. It enables Agent Zero to access your emails and Teams messages. Without this package, Agent Zero is blind to your M365 data. | Microsoft Entra ID — `workiq accept-eula` (one-time browser login to your M365 account). |
| **workiq mcp** | Engine | Spawned by the SDK's `createSession()` as a stdio subprocess (`command: 'workiq', args: ['mcp']`). Runs as an MCP server that gives the AI model direct tool access to search emails, Teams messages, and meetings. Only started for sessions that need M365 data (scan, enrich, update-check, search) — not for pure reasoning sessions. | The active data channel. When the AI needs to search your emails, the SDK starts a Work IQ process in the background. This process acts as a translator: the AI says "find emails about project X", the translator converts that into an M365 query and delivers the results back. For pure thinking tasks (e.g. "summarize this text") it is not started at all. | Uses the token from `workiq accept-eula`. |
| **Microsoft 365** | Cloud | Your M365 tenant (Exchange Online, Teams). Work IQ accesses it via the Microsoft Graph API using the token obtained during `workiq accept-eula`. | Your mailbox and Teams chats. Work IQ reads your emails and messages here — read-only, it never modifies or sends anything. | M365 account with Exchange Online. |

## Installation

**Step 1 — Clone the repository** (run from any directory):
```powershell
git clone https://github.com/JohnMavic/Work_IQ.git
```

**Step 2 — Install project dependencies** (run from the Agent Zero directory):
```powershell
cd Work_IQ\Agent_Zero
npm install
```
This single command installs everything Agent Zero needs — including components you never see directly:
- `@github/copilot-sdk` — the TypeScript library imported in `server.js`
- `@github/copilot` — the Copilot CLI, automatically pulled in as a sub-dependency of the SDK
- `copilot.exe` — the native AI engine binary (~110 MB), automatically pulled in as a platform-specific sub-dependency of the CLI (`@github/copilot-win32-x64` on Windows, `copilot-darwin-arm64` on Mac, etc.)
- `@microsoft/workiq` — the Work IQ library + CLI (available locally via `node_modules/.bin/workiq`)
- `express`, `uuid` — web server and ID generation

There is no separate installation step for the Copilot CLI or the native binary — `npm install` handles the entire chain.

**Step 3 — (Optional) Install Work IQ globally** (run from any directory):
```powershell
npm install -g @microsoft/workiq
```
This makes the `workiq` command available system-wide, which can be useful for running `workiq accept-eula` from any directory.

**Step 4 — Authenticate** (first-time only):
```powershell
workiq accept-eula
```
This opens a browser window to log in with your Microsoft 365 account. Run from the Agent Zero directory (uses local install) or from anywhere if installed globally.

GitHub Copilot authentication happens automatically on first server start — you'll see a one-time device code prompt in the terminal.

## How It Works

### Session Architecture

Every AI operation follows the same pattern in `server.js`:

1. A `CopilotClient` instance is created
2. `client.createSession()` opens a session — optionally with Work IQ as an MCP server (`{ mcpServers: { workiq: { type: 'stdio', command: 'workiq', args: ['mcp'], tools: '*' } } }`)
3. A prompt (built from skill `.md` files + task context) is sent via `session.sendAndWait()`
4. The JSON response is parsed and stored in `tasks.json`
5. The session and client are destroyed

Sessions that need M365 data (scan, enrich, update-check, search) include the Work IQ MCP server. Sessions that only need AI reasoning (intent analysis via `/api/tasks/:id/log/analyze`, ambiguity review via `/api/tasks/:id/review`) create sessions without MCP servers.

### Three-Phase Scan Pipeline

Clicking **Scan** triggers a three-phase pipeline:

1. **Discovery** (`POST /api/scan`) — scans email/Teams subjects from the last N days (configurable 1–14, default 4), creates task cards. Uses `SCAN_DISCOVERY_SKILL.md` as prompt template. Includes existing tasks (active + recent done) for AI-powered deduplication, plus a Jaccard word-similarity safety net.
2. **Enrichment** (`POST /api/tasks/:id/enrich`) — for each task, searches the original thread via Work IQ using keyword extraction from the title, retrieves full content, and generates a structured summary. Uses `ENRICH_SKILL.md`. Can flag ambiguities for user review.
3. **Update Check** (`POST /api/tasks/:id/check-update`) — detects new replies since the last enrichment by comparing against `lastUpdateCheck` or `enrichedAt` timestamps. Uses `UPDATE_CHECK_SKILL.md`. Appends updates to the existing summary.

Each task shows three step dots (● ● ●) indicating pipeline progress. Tasks glow neon cyan while an agent is working on them.

### Interactive Agent (Log/Ask)

Beyond scanning, each task has an interactive agent panel where users can ask questions or give instructions. This uses a two-phase flow:

1. **Analyze** (`POST /api/tasks/:id/log/analyze`) — AI determines intent (summarize, answer, or search) without MCP. For summarize/answer, the result is returned immediately. For search, a plan is returned for user confirmation.
2. **Execute** (`POST /api/tasks/:id/log`) — if intent was search, the confirmed plan is executed with Work IQ MCP using `SEARCH_SKILL.md` (3-attempt intelligent search with self-assessment and confidence levels).

## Features

- **Three-phase scan** with visual progress indicators
- **AI content extraction** via keyword-based Work IQ search
- **Intelligent search** — goal-oriented 3-attempt search with self-assessment and confidence levels (SEARCH_SKILL.md)
- **Post-search evaluation** — after search, AI evaluates whether task title and summary need updating based on new findings; applies changes automatically with full history traceability
- **Rename via conversation** — agent can change task titles through natural discussion
- **Add Task modal** — title, assignment, and optional context; agent auto-starts on assignment
- **Configurable scan range** — slider to choose 1–14 days of email/Teams history to scan (default: 4 days)
- **Scan abort** — stop scan safely between tasks with "⏹ Stop" button
- **Auto-cleanup** — done tasks permanently deleted after configurable retention (1–30 days slider, default: 3 days)
- **Auto-refresh** — cards update in real-time after agent work
- **Status management** — New, In Progress, Needs Attention, Escalated, On Radar, Paused, Done
- **Filter bar** with live badge counts
- **Deep links** to original emails and Teams messages (window or tab mode)
- **Ambiguity review** — AI asks clarifying questions when uncertain; user resolves inline
- **Task history** — every change, agent action, and error is logged with timestamps
- **Smart deduplication** — AI compares against existing tasks during scan
- **Server health check** — auto-reconnect with offline banner

## API Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/tasks` | GET | Return all tasks |
| `/api/tasks` | POST | Create a manual task (title + notes) |
| `/api/tasks/:id` | PATCH | Update task fields (status, notes, title, summary, enrichmentStatus, updateCheckStatus) |
| `/api/tasks/:id` | DELETE | Delete a task |
| `/api/tasks/:id/history/:index` | DELETE | Delete a single history entry (only user-generated types) |
| `/api/tasks/:id/note` | POST | Save a quick note (no agent interaction) |
| `/api/scan` | POST | Phase 1: Discovery scan (accepts `scanDays` parameter) |
| `/api/tasks/:id/enrich` | POST | Phase 2: Content enrichment |
| `/api/tasks/:id/check-update` | POST | Phase 3: Update check |
| `/api/tasks/:id/log/analyze` | POST | Intent analysis (summarize/answer/search) — no MCP |
| `/api/tasks/:id/log` | POST | Execute search with Work IQ MCP |
| `/api/tasks/:id/review` | POST | Ambiguity review resolution — no MCP |
| `/api/cleanup` | POST | Permanently delete done tasks older than `retentionDays` |

## Data Storage

All tasks are stored locally in `tasks.json` (schema version 3). The server runs three migrations on startup: v1→v2 (adds history, doneAt), status migration (active→new), and v2→v3 (adds enrichmentStatus, updateCheckStatus, enrichedAt, lastUpdateCheck). Stuck transitional statuses (enriching, checking) are reset to pending on startup.

No data is sent to external services beyond the Copilot SDK (GitHub Copilot API) and Work IQ (which queries your own M365 tenant).

## Scheduled Scan (Optional)

> **Note:** This is a prototype feature. The scheduling files contain hardcoded values that must be adapted to your environment before use.

Agent Zero can automatically scan your emails and Teams messages twice a day (default: 07:00 and 11:00) using Windows Task Scheduler. The scan runs all three phases (Discovery, Enrichment, Update Check) with full UI visibility in the browser.

### How it works

1. The Task Scheduler runs `Start-WorkIQ-Scan.ps1` at the configured times
2. The script checks if the server is running — if not, it starts it automatically via `START-AGENT-ZERO.bat`
3. The browser opens with `?autoScan=true`, which triggers the full three-phase scan in the UI
4. All progress is visible in the browser (loading overlay, timer, phase indicators)

### Setup

**Step 1 — Adapt the files to your environment:**

Open `Start-WorkIQ-Scan.ps1` and update the paths to match your installation:
```powershell
$BatFile = "E:\Work_IQ\Agent_Zero\START-AGENT-ZERO.bat"   # ← your path
$LogFile = "E:\Work_IQ\Agent_Zero\scan-log.txt"            # ← your path
```

Open `WorkIQ-Scan-Task.xml` and replace the username with your Windows user:
```xml
<Author>europe\martih</Author>         <!-- ← your domain\username -->
<UserId>europe\martih</UserId>         <!-- ← your domain\username -->
```

You can find your username by running `whoami` in PowerShell.

**Step 2 — Adjust the schedule (optional):**

In `WorkIQ-Scan-Task.xml`, change the trigger times if needed:
```xml
<StartBoundary>2026-03-08T07:00:00</StartBoundary>   <!-- Morning scan -->
<StartBoundary>2026-03-08T11:00:00</StartBoundary>   <!-- Midday scan -->
```

**Step 3 — Register the task:**

Run in PowerShell:
```powershell
schtasks /create /xml "WorkIQ-Scan-Task.xml" /tn "WorkIQ-Scan"
```

> Replace the path with the full path to the XML file if you are not in the Agent Zero directory.

### Managing the task

| Action | Command |
|---|---|
| Run now (test) | `schtasks /run /tn "WorkIQ-Scan"` |
| Check status | `schtasks /query /tn "WorkIQ-Scan"` |
| Remove task | `schtasks /delete /tn "WorkIQ-Scan" /f` |
| View in UI | Open **Task Scheduler** → click **Task Scheduler Library** → find **WorkIQ-Scan** |

### Good to know

- **PC locked (screen off):** The scan runs normally — you see results when you unlock
- **PC was off:** Missed scans are not queued — only one catch-up scan runs when the PC is back online
- **Server not running:** The script starts it automatically before scanning
- **Scan log:** All runs are logged to `scan-log.txt` in the Agent Zero directory

## Troubleshooting

| Problem | Solution |
|---|---|
| Scan returns 500 error | Check terminal for timeout — enrichment can take 60–300s per task |
| Authentication expired | Run `workiq accept-eula` and retry |
| Work IQ not found | Run `npm install` in the Agent Zero directory (installs locally), or `npm install -g @microsoft/workiq` (installs globally) |
| No AI response | Copilot auth may have expired — restart the server to trigger re-authentication, or set `GITHUB_TOKEN` env var with a [PAT](https://github.com/settings/personal-access-tokens/new) that has the "Copilot Requests" permission |
| Port 3000 in use | Stop other process or change `PORT` in server.js |

## File Structure

```
Agent_Zero/
├── server.js                    Express backend (API + AI orchestration)
├── index.html                   Single-file frontend (HTML + CSS + JS)
├── package.json                 Dependencies (v2.2.0)
├── mcp.json                     MCP server configuration (Work IQ)
├── tasks.json                   Local task storage (gitignored)
├── AGENTS.md                    Agent behavior documentation
├── START-AGENT-ZERO.bat         Auto-launcher
├── Start-WorkIQ-Scan.ps1        Scheduled scan script (see "Scheduled Scan")
├── WorkIQ-Scan-Task.xml         Windows Task Scheduler config (07:00 + 11:00)
├── scan-log.txt                 Scan log (created on first scheduled run)
├── README.md                    This file
├── docs/
│   ├── README.md                Challenge documentation (problem, solution, RAI)
│   ├── ARCHITECTURE.md          System architecture (current state)
│   ├── CHANGELOG.md             Version history (v1.0 → v2.2)
│   ├── SCAN_DISCOVERY_SKILL.md  Phase 1 prompt template
│   ├── ENRICH_SKILL.md          Phase 2 prompt template
│   ├── UPDATE_CHECK_SKILL.md    Phase 3 prompt template
│   ├── SEARCH_SKILL.md          Intelligent search prompt template (v2.2)
│   ├── SCAN_SKILL.md            Legacy scan skill (fallback)
│   ├── LOG_WORK_SKILL.md        Legacy work logging prompt (fallback)
│   ├── FEATURE_INVENTORY_Claude_Code_Codex_Analyse.md  Code review results
│   ├── VIDEO_DESCRIPTION.md     Video script foundation
│   ├── Final Video/             Final video assets
│   └── archive/                 Archived documentation
├── Specifactions/
│   └── AGENT_ZERO_SPEC.md       Product specification
├── presentations/               Presentation files (.pptx)
├── Images/                      Screenshots and diagrams
└── Security report/             Security analysis
```

For detailed architecture, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
