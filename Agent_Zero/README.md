# Agent Zero

> Version 2.2.0 · A personal AI-powered action-item tracker for Microsoft 365

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
- **Work IQ** — `npm install -g @microsoft/workiq` (v0.2.8+)
- **GitHub Copilot** — active subscription for the Copilot SDK
- **M365 account** — Work IQ needs access to your Microsoft 365

## Installation

```powershell
cd E:\Work_IQ\Agent_Zero
npm install
```

First-time only: `workiq accept-eula`

## How It Works

Clicking **Scan** triggers a three-phase pipeline:

1. **Discovery** — scans email/Teams subjects from the last N days, creates task cards
2. **Enrichment** — extracts full content from each thread via Work IQ, generates summaries
3. **Update Check** — detects new replies since the last enrichment

Each task shows three step dots (● ● ●) indicating pipeline progress. Tasks glow neon cyan while an agent is working on them.

## Features

- **Three-phase scan** with visual progress indicators
- **AI content extraction** via keyword-based Work IQ search
- **Intelligent search** — goal-oriented 3-attempt search with self-assessment and confidence levels (SEARCH_SKILL.md)
- **Add Task modal** — title, assignment, and optional context; agent auto-starts on assignment
- **Scan abort** — stop scan safely between tasks with "⏹ Stop" button
- **Auto-cleanup** — done tasks permanently deleted after configurable retention (1–30 days slider)
- **Auto-refresh** — cards update in real-time after agent work
- **Status management** — New, In Progress, Needs Attention, Escalated, Paused, Done
- **Filter bar** with live badge counts
- **Deep links** to original emails and Teams messages (window or tab mode)
- **Ambiguity review** — AI asks clarifying questions when uncertain; user resolves inline
- **Task history** — every change, agent action, and error is logged with timestamps
- **Smart deduplication** — AI compares against existing tasks during scan
- **Server health check** — auto-reconnect with offline banner

## Data Storage

All tasks are stored locally in `tasks.json`. No data is sent to external services beyond the Copilot SDK and Work IQ (which queries your own M365 tenant).

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
| Work IQ not found | `npm install -g @microsoft/workiq` |
| No AI response | Verify: `gh auth status` |
| Port 3000 in use | Stop other process or change `PORT` in server.js |

## File Structure

```
Agent_Zero/
├── server.js                    Express backend (API + AI orchestration)
├── index.html                   Single-file frontend (HTML + CSS + JS)
├── package.json                 Dependencies (v2.2.0)
├── tasks.json                   Local task storage (gitignored)
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
│   └── VIDEO_DESCRIPTION.md     Video script foundation
├── Specifactions/
│   └── AGENT_ZERO_SPEC.md         Product specification
├── Images/                      Screenshots and diagrams
└── Security report/             Security analysis
```

For detailed architecture, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
