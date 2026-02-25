# Daily Briefing App

A local, single-page application that scans your Microsoft 365 emails and Teams messages for action items and presents them in a clean, interactive task list.

## Prerequisites

- **Node.js** v18 or later — [nodejs.org](https://nodejs.org/)
- **Work IQ CLI** — installed globally: `npm install -g @microsoft/workiq` (v0.2.8+)
- **GitHub Copilot access** — the app uses the [Copilot SDK](https://www.npmjs.com/package/@github/copilot-sdk) for AI reasoning
- **M365 account** — Work IQ needs access to your Microsoft 365 emails and Teams

## Installation

```powershell
cd E:\Work_IQ\Daily_Tasks
npm install
```

## First-Time Setup

1. Accept the Work IQ EULA (one-time):
   ```powershell
   workiq accept-eula
   ```
2. Verify Work IQ can reach your M365 data:
   ```powershell
   workiq ask -q "Show my latest emails"
   ```

## Usage

**Quick Start (recommended):**

Double-click `START-DAILY-BRIEFING.bat` — this starts the server and opens the browser automatically.

**Manual Start:**

```powershell
cd E:\Work_IQ\Daily_Tasks
node server.js
```

Then open [http://localhost:3000](http://localhost:3000) in your browser.

### Features

- **Scan Emails & Teams** — click the scan button to extract action items from the last 4 days of M365 communication
- **Manual Tasks** — add tasks manually via the input form at the bottom
- **Status Management** — change task status (Active, In Progress, Done, Paused) via the dropdown on each card
- **Filter** — filter tasks by status using the buttons at the top
- **Deep Links** — click "Open source" on any scanned task to jump to the original email or Teams message
- **Task History** — every task tracks its changes (creation, status changes, work logs) in a collapsible history view
- **Work Logging** — click "✏️ Log" on a task to describe what you did; the AI automatically finds and links related emails/Teams messages
- **Auto-Cleanup** — done tasks automatically hide from the UI after 3 days (data preserved in tasks.json)
- **Smart Re-Scan** — re-scanning detects updated tasks and logs changes to history instead of creating duplicates
- **AI-Powered Deduplication (v1.3)** — the AI receives existing tasks as context during scan, preventing duplicates through semantic matching instead of exact string comparison

### Data Storage

All tasks are stored locally in `tasks.json`. No data is sent to external services beyond the Copilot SDK and Work IQ M365 queries.

## Troubleshooting

| Problem | Solution |
|---|---|
| **"Authentication expired"** during scan | Run `workiq accept-eula` in your terminal, then retry the scan |
| **"Could not start Work IQ"** | Install it globally: `npm install -g @microsoft/workiq` |
| **Scan returns no tasks** | Check that you have emails/Teams messages from the last 4 days containing action items |
| **"No response from AI engine"** | Verify your GitHub Copilot authentication: `gh auth status` |
| **Port 3000 already in use** | Stop the other process or change `PORT` in `server.js` |
| **Work IQ admin consent not granted** | Contact your M365 admin to grant consent for the Work IQ app |

## File Structure

```
Daily_Tasks/
├── Documents/
│   └── ARCHITECTURE.md            — Technical architecture reference
├── Specifactions/
│   └── DAILY_BRIEFING_APP_SPEC.md — Product specification
├── server.js                      — Node.js Express backend (API + Copilot SDK + Work IQ MCP)
├── index.html                     — Frontend (single HTML file, dark theme)
├── tasks.json                     — Persistent task data (auto-created)
├── package.json                   — Dependencies and scripts
├── START-DAILY-BRIEFING.bat       — One-click launcher (starts server + opens browser)
└── README.md                      — This file
```
