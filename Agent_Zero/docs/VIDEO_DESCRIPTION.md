# Agent Zero — Video Script Foundation

> A comprehensive description of the problem, vision, solution, and technical implementation for the Agent Zero demo video.

---

## Part 1: The Problem — Why Outlook Still Wastes Your Time

Microsoft Outlook has gotten smarter. With Copilot, you can now summarize long email threads, draft replies faster, and search your inbox with natural language. That's a genuine improvement — but it fundamentally misses the point.

Here's what Outlook still expects you to do every single morning: **Open your inbox. Read through dozens of emails and Teams messages. Mentally decide which ones require action from you. Remember those action items. Track their status in your head — or worse, in a separate to-do list that immediately goes stale.**

Copilot can summarize an email once you've already found it and opened it. But it doesn't proactively scan your inbox for the emails that actually matter. It doesn't distinguish between an FYI newsletter and a direct request from your manager with a Friday deadline. It doesn't monitor whether someone replied to that critical thread you've been waiting on. It doesn't tell you: *"Three things need your attention today — here they are, here's what's being asked, and here's what changed since yesterday."*

The core problem is this: **Outlook remains a passive tool.** It waits for you to come to it, scroll through everything, and do the cognitive work of identifying what matters. Copilot made the reading faster, but it didn't eliminate the reading. You still spend 30–60 minutes every morning just triaging your inbox — sorting the signal from the noise.

And once you've identified an action item, you're on your own. There's no AI that lets you ask follow-up questions about a task — *"Who was supposed to send the updated SOW?"* or *"Did anyone confirm the server room access for Thursday?"* — and then goes back into your M365 data to find the answer. Outlook gives you the raw messages. What you do with them is your problem.

**That's the gap Agent Zero fills.**

---

## Part 2: The Vision — Zero Time in Your Inbox

The name "Agent Zero" is intentional. The zero stands for a simple, ambitious goal: **you should spend zero time doing traditional inbox triage.**

Instead of opening Outlook every morning and manually scanning through messages, you open Agent Zero, press one button, and within minutes you have a complete, prioritized dashboard of everything that requires your attention — extracted from your emails and Teams messages, summarized by AI, and ready for you to act on.

But Agent Zero doesn't stop at discovery. It's designed as a **personal AI agent** — not just a scanner, but an intelligent partner that understands the context of your work. You can talk to it. You can ask it questions about your action items, and it will go back into your Microsoft 365 data — your emails, your Teams chats, your sent messages — to find the answer. If something changed, it tells you. If information is missing, it tells you that too, honestly, instead of guessing.

The vision is a fundamental shift in how knowledge workers interact with their communication:

- **From passive to proactive:** The AI comes to you with what matters, instead of you hunting for it.
- **From reading to reviewing:** You see summaries and action items, not raw email threads.
- **From remembering to monitoring:** The agent tracks updates and flags changes automatically.
- **From searching to asking:** Instead of constructing search queries, you ask questions in plain language and the agent finds the answer.
- **From context-switching to flow:** Everything lives in one dashboard — no jumping between Outlook, Teams, OneNote, and your personal task list.

In short: Agent Zero is the intelligent layer between you and your Microsoft 365 data that Outlook should have been all along.

---

## Part 3: How Agent Zero Solves It

Agent Zero addresses each of these problems through a three-phase AI pipeline and an interactive agent you can converse with.

### 3.1 — One-Click Scan (The Three-Phase Pipeline)

When you click "Scan," Agent Zero runs a fully automated pipeline across your emails and Teams messages:

**Phase 1 — Discovery:**
The AI scans your inbox and Teams for messages from the last N days (configurable). But it doesn't just list everything — it intelligently filters. It identifies only messages where *you* are expected to take action: respond, review, approve, deliver something. FYI newsletters, automated notifications, and messages where you're just in CC are ignored. Each action item is created as a task card with the exact subject line, sender, source, and date — no rephrasing, no AI hallucination of titles.

The AI also performs **smart deduplication**: it compares every new finding against your existing tasks (both active and completed) to avoid creating duplicates. If a message matches something you've already handled, it skips it.

**Phase 2 — Enrichment:**
For each newly discovered task, the agent goes deeper. It searches your M365 data for the full conversation thread — all replies, forwards, and related messages — and generates a concise 2–4 sentence summary. This summary captures what the conversation is about, what is being asked of you, and key details like deadlines, amounts, names, and decisions. After this phase, you can understand the full situation *without ever opening the original email.*

The enrichment uses a sophisticated three-attempt search strategy: first with targeted keywords, then with broader terms, and finally by searching messages from the specific sender. This ensures high recall even when email subjects are vague or abbreviated.

**Phase 3 — Update Check:**
For tasks that were already enriched in a previous scan, the agent checks whether anything new has happened. Did someone reply? Was there a follow-up message? If so, the summary is updated with the new information, clearly marked as an update. This means your dashboard stays current without you having to re-read any threads.

The entire pipeline runs with real-time visual feedback: each task card shows three progress dots (Discovery ● Enrichment ● Update), and tasks glow with a neon cyan animation while the agent is actively working on them.

### 3.2 — Conversational Agent (Ask Questions, Get Answers)

This is where Agent Zero goes far beyond any inbox scanner. Every task card has an interaction panel where you can have a conversation with the AI about that specific action item.

**Example scenarios:**
- You see a task about a server room survey. You type: *"Who is performing the survey?"* — The agent searches your emails and Teams messages, finds the specific communication where the person was named, and responds: *"Mark Higgins from WWT, confirmed in his email from February 17th."* It cites its source.
- You have a task about an invoice approval. You ask: *"What's the total amount?"* — The agent finds the relevant email thread, extracts the number, and gives you a direct answer with confidence level.
- You ask: *"Did anyone reply to this since Monday?"* — The agent checks for new communications and gives you an honest answer: either the specific reply it found, or a clear "no new replies found."

The agent is **goal-oriented, not keyword-oriented.** It doesn't just return emails that contain your search terms — it evaluates whether the results actually *answer your question.* If it finds emails that match keywords but don't contain the answer, it discards them and honestly tells you it couldn't find what you're looking for. An honest "nothing found" is more valuable than irrelevant noise.

The agent also supports **bilingual searching**: if your emails are in German but you ask a question in English (or vice versa), it automatically translates search terms and searches in both languages.

### 3.3 — Status Management & Workflow

Each task can be managed through a lifecycle: New → In Progress → Needs Attention → Escalated → Paused → Done. A filter bar with live badge counts lets you instantly see how many items need attention, how many are new, and how many you've completed. Done tasks are automatically cleaned up after a configurable retention period (default: 3 days), keeping your dashboard focused on what's current.

Deep links on every task card take you directly to the original email or Teams message when you need the full context — one click, and you're there.

---

## Part 4: How We Built It — Technical Architecture

Agent Zero is built as a lightweight, fully local application. No cloud service, no external backend, no data leaving your machine beyond what's needed to query your own Microsoft 365 tenant.

### Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Frontend** | Single-file HTML/CSS/JS | Dark-themed dashboard, runs in any browser |
| **Backend** | Node.js + Express | REST API, scan orchestration, skill file management |
| **AI Engine** | GitHub Copilot SDK | Prompt execution, LLM reasoning, response parsing |
| **Data Access** | Microsoft Work IQ (MCP)  | Queries your M365 emails, Teams messages, calendar |
| **Storage** | Local JSON file | All tasks stored in `tasks.json` on your machine |

### How the AI Works

The intelligence comes from **skill files** — carefully engineered prompt templates stored as Markdown files. Each phase of the pipeline and each type of agent interaction has its own skill file:

- `SCAN_DISCOVERY_SKILL.md` — instructs the AI how to identify actionable messages
- `ENRICH_SKILL.md` — instructs the AI how to extract and summarize full conversation content
- `UPDATE_CHECK_SKILL.md` — instructs the AI how to detect new replies
- `SEARCH_SKILL.md` — instructs the AI how to answer user questions intelligently
- `LOG_WORK_SKILL.md` — instructs the AI how to find communications related to work the user performed

Each API call creates a fresh Copilot SDK session with Work IQ as an MCP (Model Context Protocol) server. The SDK handles the LLM communication; Work IQ provides the bridge to Microsoft 365 data via the Microsoft Search API. Sessions are stateless and independent — no shared context between calls, which keeps the system simple and predictable.

### Data Privacy

All data stays local. The `tasks.json` file on your machine is the only data store. The Copilot SDK communicates with the LLM, and Work IQ queries your own M365 tenant — but no task data, summaries, or conversation history is sent to any third-party service. The application runs on `localhost:3000` and is accessible only from your machine.

### Getting Started

The entire setup is a double-click: `START-AGENT-ZERO.bat` launches the server, opens the browser, and you're ready to scan. No Docker, no cloud deployment, no configuration files — just Node.js and your Microsoft 365 account.

---

*Agent Zero v2.2.0 — Built by Martin Hämmerli, powered by GitHub Copilot SDK and Microsoft Work IQ.*
