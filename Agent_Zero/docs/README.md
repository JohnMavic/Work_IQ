# Agent Zero — Solution Documentation

> Version 5.1.0 · July 15, 2026 · GitHub Copilot Enterprise Challenge

---

## Problem Statement

Knowledge workers at Microsoft carry real undertakings — a migration, a procurement, a rollout, an access request — across dozens of fragmented emails and Teams messages. The signal for any one project is scattered across many threads, senders, and days, and there is no single place that says *what this project currently is, what is blocking it, and what I personally still have to do.*

The core challenge is not "too many messages to read." It is the **absence of a project-level, prioritized, evidence-backed source of truth.** Individual messages get summarized; the undertaking they belong to does not.

---

## Solution

**Agent Zero** is a personal, locally run project-task tracker for Microsoft 365. Its default engine is the **Agency Brain**: an `agency.exe copilot` child process that reads a rendered snapshot of the current task state, calls **WorkIQ** (inherited from the user's Copilot MCP configuration) to gather recent mail and Teams evidence, and returns validated changes that the server applies to a local `tasks.json`.

Agent Zero organizes work the way a project manager would:

- **Project tasks** collect the many signals of one real undertaking into a single record with **line items** (workstreams, actions, decisions, dependencies, risks, info) and a living **Fact Sheet** of deep evidence.
- **Standalone (single) tasks** are kept only for genuinely standalone work that does not belong to a larger undertaking.
- New evidence **updates an existing project first**; a brand-new project is created only for a genuinely separate undertaking.

### How a scan works

A scan is one server job (`POST /api/jobs` with `kind:"scan"`). The Agency Brain never edits `tasks.json` directly — it emits one **marker** per line, and every marker passes an ordered validation pipeline before anything is written:

1. **Render** — the current state is written into an isolated `brain-work/` sandbox.
2. **Run** — the Agency child runs with the `AGENCY_BRAIN_SCAN_SKILL.md` skill and gathers evidence through WorkIQ.
3. **Project-identity gate** — each candidate is resolved against a canonical identity index so one undertaking never splits into two top-level records.
4. **Bounded processing-quality correction** — a single, non-looping pass that repairs only provable omissions for items the scan already enumerated (it can never invent an item).
5. **Reality Gateway** — an independent verification pass that **fails closed**: markers that cannot be verified are held and turned into review items rather than applied.
6. **Final processing-quality + temporal gates** — enforce ledger completeness, attachment handling, discovery coverage, and stale-date resolution.
7. **Atomic apply** — surviving markers are applied and `tasks.json` is written via temp file → fsync → rename with `.1.bak`–`.3.bak` rotation.

### Shared truth, learnings, evidence, and time

- **Truth tree** — every node carries a state (`unconfirmed | confirmed | disputed | superseded | obsolete`) with its sources; contradictions are marked `disputed`, never silently resolved.
- **Evidence enforcement** — any new or changed status, problem, risk, waiting item, or user action requires an evidence reference, with links copied verbatim from WorkIQ (no constructed links). Date-only evidence caps confidence at *medium*.
- **Temporal precedence** — current WorkIQ evidence outranks older summaries and stored learnings; superseded facts are labeled as historical.
- **Shared learnings** (`brain-learnings.md`) — reusable operating memory only (methods/patterns), never treated as evidence that a current source still holds a state.

### Discovery coverage and attachments

- **Two independent discovery passes** run over the exact discovery window: a `recent-email-enumeration` pass and a `material-consequence` pass (judged by meaning, not by sender/subject/keyword allow-lists). A missing pass makes the run *partial*.
- **Attachment awareness** — items with attachments are probed against the WorkIQ/M365 index (indexed content, not raw bytes). On `content-not-indexed` the brain retries once; a persistent miss is recorded as `failed(content-not-indexed)` and re-probed on later scans.
- **Source-coverage warning** — when attachment handling is incomplete, the UI shows an explicit incomplete-source-coverage indicator instead of hiding the gap.

### Semantic relevance and decision-oriented UI

- **Model-assessed relevance** — each active line item carries a 0–100 relevance score with a plain-English project consequence and evidence references, grouped into bands: **Act now** (75–100), **Next** (50–74), **Monitor** (25–49), **Reference** (0–24). Relevance is independent of confidence and review status.
- **Executive Brief** — a per-project header summarizing blockers, user actions, risks, and the next milestone so the project can be understood without rereading the source stream.
- **Decision Focus** — the items that most need a decision, each with a short rationale.
- **Responsive layout** for desktop and mobile, including reduced-motion support. Owner/Due chips stay hidden when they carry no meaningful value.

### Project-first consolidation

Consolidation happens *up front* by matching the canonical project identity and attaching new evidence to the existing project. **Merge is a safety net, not the normal path** — the identity gate and fragment reconciliation catch stray fragments after the fact. (The legacy consolidate/merge endpoints exist only in legacy mode.)

---

## Project Structure

Agent Zero is a Node.js + single-page-HTML application whose scan intelligence lives in a dedicated `brain/` module. It is deliberately buildless (no bundler, no `/dist`) but it is **not** a two-file application:

```
Agent_Zero/
├── server.js                     Express backend: job registry, scan orchestration, atomic persistence
├── index.html                    Single-file frontend (Executive Brief, Decision Focus, relevance UI)
├── package.json                  Dependencies and version 5.1.0
├── mcp.json                      Legacy-only WorkIQ MCP config (Agency mode does not read it)
├── tasks.json                    Local task storage (schema v5, gitignored)
├── brain-learnings.md            Curated shared learnings (operating memory)
├── AGENTS.md                     Agent behavior documentation
├── START-AGENT-ZERO.bat          Windows launcher (defaults AGENT_ZERO_SCAN_ENGINE=agency)
├── Start-WorkIQ-Scan.ps1         Task Scheduler entry (staleness check, one scan job)
├── stop-agent-zero.ps1           Path-restricted safe shutdown
├── who-is-agent-zero.ps1         Read-only process classifier
├── brain/                        Agency scan engine (runner, markers, gates, relevance, truth tree)
├── brain-work/                   Agency sandbox (rendered state + spill files)
├── docs/                         Documentation + skill files
│   ├── AGENCY_BRAIN_SCAN_SKILL.md  Primary scan skill + marker contract
│   ├── ARCHITECTURE.md             Detailed technical architecture
│   ├── CHANGELOG.md                Version history
│   └── *_SKILL.md                  Legacy fallback skills (active only in legacy mode / manual route)
├── Specifactions/                Product specification
└── tests/unit/                   Node test suite (node --test)
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Browser (index.html)                     │
│  Dark SPA · Executive Brief · Decision Focus · Line items    │
└────────────────────────────┬────────────────────────────────┘
                             │ HTTP (localhost:3000) + SSE
┌────────────────────────────┴────────────────────────────────┐
│                    Express Server (server.js)                │
│  Job registry · Scan orchestration · Atomic task persistence │
└────────┬───────────────────────────────┬────────────────────┘
         │ POST /api/jobs kind:"scan"     │ fs (atomic read/write)
┌────────┴─────────────────┐     ┌────────┴─────────────┐
│  brain/scan-brain.js     │     │  tasks.json          │
│  runBrainScanOnce()      │     │  schema v5, gitignored│
└────────┬─────────────────┘     └──────────────────────┘
         │ render-scan-state.js → brain-work/ sandbox
         ▼
┌───────────────────────────────────────────────────────────────┐
│  brain/brain-runner.js → spawns agency.exe copilot             │
│  + AGENCY_BRAIN_SCAN_SKILL.md → markers → validation gates     │
└────────┬──────────────────────────────────────────────────────┘
         │ inherits ~/.copilot/mcp-config.json
         ▼
     WorkIQ MCP ── Microsoft 365 (mail · Teams · attachments)
```

**Data flow:** Browser → Express job → render state into `brain-work/` → Agency child → WorkIQ → marker output → validation gates → atomic write to `tasks.json` → SSE back to the browser.

### Technology Stack

| Component | Technology | Notes |
|---|---|---|
| Runtime | Node.js | v18+ |
| Web framework | Express | 5.x |
| Scan engine | Agency CLI (`agency.exe copilot`) | Spawned per scan; not an npm dependency |
| Requested model | `claude-opus-4.8` | Requested via `--model`; honoring not independently verified |
| M365 data access | WorkIQ MCP | Inherited from `~/.copilot/mcp-config.json` in Agency mode |
| Legacy AI path | `@github/copilot-sdk` + local `@microsoft/workiq` 0.2.8 | Only active with `AGENT_ZERO_SCAN_ENGINE=legacy` |
| Frontend | Single-file HTML/CSS/JS | No build step |
| Data storage | JSON file (`tasks.json`, schema v5) | Atomic writes + `.1.bak`–`.3.bak` rotation |

> **Model caveat:** the requested model is recorded in `tasks.json` brain telemetry, but requesting a model through a command-line flag does not by itself prove which model actually served the run.

---

## Prerequisites

- **Node.js** v18+ — [nodejs.org](https://nodejs.org/)
- **GitHub Copilot CLI / Agency runner** — the default scan engine spawns `agency.exe copilot`.
- **WorkIQ configured in the user's Copilot MCP configuration** (`~/.copilot/mcp-config.json`). In Agency mode the server does **not** start its own WorkIQ subprocess; it inherits WorkIQ from that configuration.
- **Microsoft 365 account** — WorkIQ queries the authenticated user's own M365 tenant.

> **Legacy prerequisites (only for `AGENT_ZERO_SCAN_ENGINE=legacy`):** the repo `mcp.json` and a local `@microsoft/workiq` (0.2.8) subprocess. These are **not** used by the default Agency engine.

## Setup & Deployment

```bash
# Clone the repository
git clone https://github.com/JohnMavic/Work_IQ.git
cd Work_IQ/Agent_Zero

# Install dependencies
npm install

# Start the server (Agency engine)
#   START-AGENT-ZERO.bat sets AGENT_ZERO_SCAN_ENGINE=agency for you.
#   A bare `node server.js` inherits the environment as-is, so set it explicitly for a manual run:
set AGENT_ZERO_SCAN_ENGINE=agency
node server.js
# Or double-click START-AGENT-ZERO.bat on Windows
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Deployment Model

Agent Zero runs **on the user's machine**. Task state persists locally in `tasks.json`. This is a local-first design, but it is **not** an air-gapped one: a scan invokes the Copilot/Agency runner and WorkIQ, which communicate with Microsoft 365 and the model backend to gather and reason over evidence. What stays local is the task database and its backups; what leaves the machine is limited to the queries the runner and WorkIQ make against the user's own tenant and the model provider.

---

## Business Value Proposition

### For individual knowledge workers
- **See each undertaking as one prioritized project** instead of re-deriving it from scattered threads.
- **Understand status at a glance** via the Executive Brief and Decision Focus, without rereading the source stream.
- **Trust what you read** — every status/problem/risk/waiting/user-action change is backed by an evidence reference, and uncertain items are quarantined for review rather than asserted.

### For enterprise adoption
- **Local-first task store** — the task database lives on the user's machine.
- **Works with existing M365** — evidence is gathered from the user's own mail and Teams via WorkIQ.
- **Agency + WorkIQ showcase** — demonstrates a validated, marker-based agent pipeline with fail-closed verification on top of the Copilot platform.

---

## Responsible AI (RAI) Notes

### Data & retention
- Task data is stored locally in `tasks.json` (gitignored) with atomic writes and rotating `.bak` backups. WorkIQ accesses only the authenticated user's own M365 data.
- A scan is **not** air-gapped: the Agency/Copilot runner and WorkIQ communicate with Microsoft 365 and the model backend. Locality applies to the task database, not to the queries the runner makes.
- Completed tasks can be cleaned up after a retention period via `POST /api/cleanup`.

### Evidence, verification, and honesty
- **Evidence enforcement** — state changes require evidence references; links are copied verbatim from WorkIQ (no constructed links); date-only evidence caps confidence at *medium*.
- **Reality Gateway fails closed** — markers that cannot be independently verified are held and turned into review items rather than applied. A scan can therefore be *partial* without any error.
- **Hallucination prevention** — the brain must not emit unsupported facts as task state; an item that WorkIQ never surfaced is simply out of scope for that run, not invented.
- **Temporal precedence** — current evidence outranks older summaries and stored learnings.

### Human oversight
- Scans are user-initiated. Low-confidence ownership/status decisions and every gate hold become `NEEDS_REVIEW` for the user to resolve.
- Users can edit or override AI-generated content. External writes (sending mail, approvals, calendar or ticket changes) are never performed unless the user explicitly requests that exact write.

### Observability (and its limits)
- Each scan records brain telemetry (`engine`, requested `model`, run id/time, outcome, premium-request and WorkIQ-call counts) and per-item processing-quality fields.
- The **requested** model (`--model claude-opus-4.8`) is recorded but not independently proven by the flag; telemetry reflects what was requested, not verified serving.
- Per-scan reasoning is not persisted as a durable human-readable search log; live progress is streamed over SSE while a job runs, and validated outcomes (with evidence references and review items) are what persist.

### Limitations
- **Never-enumerated items cannot be repaired.** The correction pass only supplies a missing disposition for an item the scan already enumerated; a message WorkIQ never surfaced is out of scope for that run.
- **Attachment bytes are not fetched.** WorkIQ surfaces indexed attachment content; index lag can force `failed(content-not-indexed)` and a later re-probe, and incomplete coverage is surfaced in the UI.
- WorkIQ relies on the Microsoft Search API, which may not index every message immediately.
- The legacy four-phase SDK engine is fallback-only (`AGENT_ZERO_SCAN_ENGINE=legacy`).

---

## Related Documentation

- [Architecture Details](ARCHITECTURE.md)
- [Primary Scan Skill](AGENCY_BRAIN_SCAN_SKILL.md)
- [Changelog](CHANGELOG.md)
- [Product Specification](../Specifactions/AGENT_ZERO_SPEC.md)
- [Agent Instructions](../AGENTS.md)
- [Operations & Process Hygiene](../../.github/copilot-instructions.md)
