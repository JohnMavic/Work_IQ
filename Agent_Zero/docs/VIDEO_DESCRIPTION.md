# Agent Zero — Video Script Foundation

> A narrative foundation for the Agent Zero demo video: the user's real pain, the value, and how the current Agency Brain engine actually works. Version 5.1.0.

---

## Part 1: The Problem — Your Projects Live in a Hundred Places

Your real work isn't "emails." It's undertakings: a migration, a procurement, a rollout, an access request, a renovation. Each one is real, each one has a status, a blocker, a next step — and a deadline.

But none of them live in one place. The signal for a single project is smeared across dozens of email threads and Teams chats, from different people, over many days. An approval here, a spec change there, a "can you confirm by Friday" buried three replies deep.

Modern tools made the *reading* faster. Copilot can summarize a thread once you've found and opened it. What no tool gives you is the thing you actually need: **one prioritized, evidence-backed view of each project that says what it currently is, what is blocking it, and what *you personally* still have to do.**

So you rebuild that picture in your head every morning — re-reading threads, stitching updates together, hoping you didn't miss the one message that changes everything. And when you ask yourself *"who was supposed to send the updated SOW?"* or *"did anyone confirm the server room access for Thursday?"*, the answer is somewhere in your mailbox, and finding it is your problem.

**That's the gap Agent Zero fills: it turns scattered messages into project-level truth.**

---

## Part 2: The Vision — One Truth Per Project

Agent Zero's ambition is simple: **for every undertaking you care about, there is exactly one living record — and it tells you what to decide next.**

You open Agent Zero and press one button. A scan gathers the recent signal from your mail and Teams and folds it into project cards. Each card leads with an **Executive Brief** (blockers, the actions that are yours, risks, the next milestone) and a **Decision Focus** list of the items that most need a decision right now. Below that, line items are ordered by how much they actually matter — *Act now*, *Next*, *Monitor*, *Reference* — not by when they arrived.

Crucially, Agent Zero is honest about what it knows. Every status or risk it shows is backed by a specific piece of evidence. When it isn't sure who owns something or whether a fact still holds, it doesn't guess — it flags the item for your review. And when a message it never managed to find could matter, it says so, rather than pretending the picture is complete.

The shift the video should land:

- **From a stream of messages to a set of projects** — the unit of work is the undertaking, not the inbox.
- **From "read everything" to "decide the top things"** — the Executive Brief and Decision Focus do the framing.
- **From confident-sounding guesses to evidence and honest gaps** — every claim has a source, and missing coverage is surfaced.
- **From remembering to being told what changed** — new evidence updates the existing project instead of starting a new pile.

---

## Part 3: How Agent Zero Solves It

Agent Zero addresses each of these problems through the Agency Brain scan and an interactive agent you can converse with.

### 3.1 — One project, assembled from many messages

When you scan, Agent Zero doesn't just list new emails. It resolves each signal to the **one real undertaking** it belongs to and updates that project first — a new spec, a fresh approval, a changed date all land on the same card as new **line items** and a living **Fact Sheet**. A brand-new project is created only when the work is genuinely separate. Truly standalone actions stay as simple single tasks.

### 3.2 — Relevance you can act on

Every active line item gets a model-assessed **relevance score** with a plain-English reason for the *project* consequence — "blocks go-live," "needed before the Friday approval," "informational." Items are grouped into **Act now / Next / Monitor / Reference** bands so the card reads like a prioritized plan, not a timeline of arrivals. Relevance is judged separately from confidence: something can be urgent *and* still flagged for review.

### 3.3 — Evidence, attachments, and honest coverage

Nothing meaningful changes without a source. Every status, problem, risk, or "waiting on" carries an evidence reference with a link copied verbatim from the source — Agent Zero never fabricates a citation. When an item has attachments, it probes the WorkIQ/M365 index for their content; if that content isn't indexed yet, it retries once, and if it still can't reach it, it records an honest `failed` and shows an **incomplete source-coverage** indicator instead of hiding the gap.

### 3.4 — Two-pass discovery over a fixed window

A scan runs **two independent passes** across the same time window. The first simply enumerates the recent mail set. The second, judged by meaning, looks for anything where inaction could cause a real consequence — security, access, compliance, an account, a device, a payment, a project slip — regardless of who sent it or what the subject says. If either pass is incomplete, the scan reports itself as *partial* rather than claiming it saw everything.

### 3.5 — Talk to a task

Every task still lets you ask questions in plain language — *"who confirmed the server room access?"* — and the agent goes back into your M365 data to find the answer, cites where it found it, and tells you honestly when it couldn't. It searches by meaning, in both the language of your question and the language of your mail.

---

## Part 4: How We Built It — The Agency Brain Pipeline

Agent Zero's current engine is the **Agency Brain**, not a chain of separate Copilot-SDK phases. A scan is one job. The server renders the current task state into an isolated `brain-work/` sandbox and launches an `agency.exe copilot` child with a single skill file (`AGENCY_BRAIN_SCAN_SKILL.md`). WorkIQ is inherited from the user's Copilot MCP configuration, so the brain can gather mail and Teams evidence without the server running its own data subprocess.

### Markers, not direct writes

The brain never edits the task file. It emits one **marker** per line — create a project, update a line item, patch a Fact Sheet, flag something for review. Those markers only become real state after passing an ordered pipeline:

1. a **project-identity gate** so one undertaking never becomes two records;
2. a single, bounded **processing-quality correction** that can only repair a missing disposition for an item the scan *already enumerated* — it can never invent one;
3. an independent **Reality Gateway** that **fails closed** — anything it can't verify is held for review, not written;
4. **final quality and temporal gates**; then
5. an **atomic write** to `tasks.json` with rotating backups.

### The boundaries we're honest about

- **No perfect recall.** An item WorkIQ never surfaced cannot be recovered by any later step — the honest result is a *partial* scan and a review flag, not an invented task.
- **Attachment index lag is shown, not hidden.** The brain reads indexed attachment content, not raw bytes; when the index lags, coverage is marked incomplete and re-probed later.
- **Local-first, not air-gapped.** The task database lives on your machine, but a scan does talk to Microsoft 365 (via WorkIQ) and to the model backend. We say "local-first," not "nothing ever leaves."
- **Requested vs. served model.** We request a specific model on the command line and record it, but a flag doesn't prove which model actually served a run — telemetry shows what was requested.

### Getting Started

Launch with `START-AGENT-ZERO.bat`, which selects the Agency engine, starts the server, and opens the dashboard. No cloud deployment, no bundler — Node.js plus your Microsoft 365 account.

---

*Agent Zero v5.1.0 — Built by Martin Hämmerli. Default scan engine: the Agency Brain (Agency CLI + WorkIQ over Microsoft 365).*
