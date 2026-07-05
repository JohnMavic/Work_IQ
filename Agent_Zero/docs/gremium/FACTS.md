# Faktenbasis (code-verifiziert, 2026-07-05)

Vier unabhängige Analysen (Agent Zero, Task Zero 03, Seestrasse-Domäne, Tooling).
Alle Datei:Zeile-Angaben wurden am Code erhoben; bei Zweifel am Code nachprüfen.

## 1. Agent Zero heute (E:\Work_IQ\Agent_Zero, v4.1.0)

**Pipeline (4 Phasen):**
- Phase 1 «Discovery» (`POST /api/scan`, server.js:2559-2873): KEIN LLM. Zwei hartkodierte
  Natural-Language-Fragen an WorkIQ (server.js:2596-2597); Markdown-Antwort wird per Regex
  geparst (parseMarkdownEmails server.js:4089, parseTeamsMessages server.js:4126). Jedes Item
  wird `action:'new'` (server.js:2659, 2675) → 1 Task pro Nachricht.
- Phase 2 «Enrich» (server.js:2876-3047): Copilot-SDK-Session pro Task, Tools ask_work_iq +
  parallel_search, Prompt = docs/ENRICH_SKILL.md + Titel-Keywords. Strikt Thread-scoped.
- Phase 3 «Update Check» (server.js:3052-3332): pro Task, Query-Budget 3, Tristate-Outcome.
- Phase 4 «Consolidate» (server.js:3335-3436): liefert Merge-VORSCHLÄGE als HTTP-Response,
  wird NICHT persistiert; der geplante Scan verwirft sie (Start-WorkIQ-Scan.ps1:179-181).
  Merge selbst nur manuell (POST /api/tasks/merge, server.js:3439-3611).

**Warum Projekte zerfallen (Kern-Gaps):**
- Kein Projekt-Feld im Datenmodell (kein projectId/parentId/lineItems) — Task = E-Mail-Thread.
- Einzige Zusammenführung: isSimilarTitle (server.js:1019-1029), Jaccard>0.6 auf Titel-Wörter.
- Toter Code: SCAN_DISCOVERY_SKILL.md wird geladen (server.js:902) aber nie in einen Prompt
  gegeben; action:'update'/'skip'-Zweige (server.js:2709-2757) und Link-Dedup (2767-2781)
  unerreichbar.
- CONSOLIDATE_SKILL.md Zeile 21 enthält Anti-Beispiel «LAN repair Seestrasse + Power outage
  Seestrasse | do not merge» → primt aktiv GEGEN Projekt-Gruppierung; Summaries auf 150
  Zeichen gekürzt (server.js:3354).
- Phase 2/3 sehen immer nur EINEN Task — Projekt-Erkennung unmöglich.
- Nach manuellem Merge re-fragmentiert der nächste Scan (neue Links/Betreffs matchen den
  Merge-Titel nicht).
- Bug: Start-WorkIQ-Scan.ps1 sendet `{"days":N}`, Server liest `req.body.scanDays`
  (server.js:2560) → Parameter wirkungslos, immer Default 4 Tage.

**Infrastruktur heute:**
- WorkIQ: @microsoft/workiq **0.2.8 gepinnt**, Server spawnt eigenen MCP-Subprozess
  (server.js:100-106), JSON-RPC über stdin/stdout, viel Stub-/Recycle-/Retry-Härtung
  (server.js:62-477). mcp.json ist deklarativ, ungenutzt.
- LLM: @github/copilot-sdk ^0.2.1, frische Session pro Aufruf, KEIN Modell gesetzt,
  approveAll, max 4 parallel, per-Task-Queue (server.js:718-809).
- Task-Store: tasks.json v4, 76 Tasks (24 mit Zurich/Seestrasse im Titel, ≥8 dasselbe
  Projekt). Felder u.a. id/title/summary/source/from/date/link/additionalLinks/status/
  history[]/enrichmentStatus/updateCheckStatus/ambiguities/noMergeWith.
- Frontend: index.html Single-File-SPA, FLACHE Task-Liste, Filter nur nach Status,
  3-Panel-Layout, SSE-Jobs, Merge-UI, Consolidation-Banner nur bei manuellem «Find
  Duplicates».
- Scheduling: Task Scheduler 07:00/11:00 → Start-WorkIQ-Scan.ps1 → REST-Phasen sequenziell.
  Single-Instance-Lock, Server-Neustart-Logik im PS1.

## 2. Referenzmuster Task Zero 03 (E:\Task_Zero 03)

- Ruft in Produktion `agency copilot` auf (Engine-Switch copilot-cli.js:45-49;
  TASK_ZERO_CLI_ENGINE=agency in START-TASK-ZERO.bat:111).
- Binary-Auflösung via where.exe (WinGet-Shim-Trap!), memoized (copilot-cli.js:51-132).
- argv Agency-Engine: `['copilot','--no-default-mcps','--max-autopilot-continues','0',
  '--model','claude-opus-4.8','--effort','high','--context','long_context']` + Run-Args
  `['-p',prompt,'--yolo','--output-format','json','--stream','on','--no-ask-user']` +
  `--session-id <uuid>` (agency) bzw. `--name/--resume` (copilot) + `--add-dir` je Ordner +
  `--allow-all-tools`. env: COPILOT_MODEL-Pin; AGENCY_RING=Prod, AGENCY_NO_UPDATE_CHECK=1.
- 32-KB-CreateProcess-Limit: Prompt >16 KB → Kontext in per-Run-unique Datei + Mini-Bootstrap
  (brain.js:821-858), Cleanup auf jedem Settle-Pfad.
- Zwei Memory-Layer: (1) CLI-Session pro Projekt (wegwerfbar), (2) `project-memory.md` vor
  JEDEM Run frisch aus project.json gerendert; Regel «Disk schlägt Session-Memory».
  skipSystemPrompt auf Resume-Turns (Token-Ökonomie).
- Marker-Protokoll: rigide Single-Line-Grammatik (prompts/system-prompt.md:134-235),
  Batch-Parse mit Fence-Tracker, fail-closed Validierung, Coercion nur auf Parse-Failure-Pfad.
- Robustheit: 30-min-Timeout + Salvage (≥200 B), Single-Settle-Flag, Wall-Clock-Watchdog,
  Silent-Failure-Signatur (exit≠0 + 0 B stdout + 0 B residual stderr; agency-stderr-Banner
  herausgerechnet via services/agency-banner.js), Once-per-Cycle-Resume-Recovery,
  Environmental-Klassifikation (Sleep/Wake), killTree, saveProjectAtomic (tmp+fsync+rename+bak).
- WorkIQ: NULL eigener Code. `~/.copilot/mcp-config.json` → mcpServers.workiq =
  `npx -y @microsoft/workiq@1.0.0 --account martih@microsoft.com mcp`, nur Tool `ask`.
  Das CLI-Kind erbt die Config automatisch (--no-default-mcps betrifft nur agency-eigene MCPs).
  GUI-Routen GET/POST /api/workiq-account lesen/reparieren die Config (server.js:1056-1140).
- Als übernehmbar bewertet: copilot-cli.js (~300 Z.) quasi verbatim; Guide-Skeleton als
  Spawn-Envelope-Basis; Layer-2-Pattern; Resume-Recovery; Batch-only-Marker; saveAtomic;
  killTree. Als Overengineering für Agent Zero: Stream/Batch-Ledger-Reconciliation,
  Learning-Wiki, marker-coerce (erst bei nachgewiesenem Drift), mail-bridge, volle
  BrainRegistry-Klasse.

## 3. agency-CLI (getestet 2026-07-05)

- agency 2026.7.4.1, wrappt GitHub Copilot CLI 1.0.69-1. Default-Modell claude-opus-4.8.
- Funktionierender Headless-Run (getestet): `agency copilot -p "…" --allow-all-tools -s`
  → stdout NUR Agent-Antwort, Banner/MCP-Noise auf stderr, exit 0.
- `--output-format json` → JSONL-Events: assistant.message_delta, assistant.message,
  tool.execution_*, finales `{"type":"result","sessionId","exitCode","usage":{…}}`.
  Headless = Autopilot-Modus, endet über internes task_complete.
- Sessions: `-n/--name`, `-r/--resume`, `--session-id <uuid>`, `--continue`.
- Weitere relevante Flags: --no-ask-user, --add-dir (mehrfach), --model, --effort
  none…max, --context long_context, --no-default-mcps, --disable-mcp-server,
  --max-autopilot-continues, --generate-result <pfad.json> (maschinenlesbar!),
  --attachment, -C <dir>, --no-auto-update, --max-ai-credits.
- Kosten/Latenz: trivialer Run ≈16 s (MCP-Startup dominiert), usage.premiumRequests=15.
  → wenige große Runs statt vieler kleiner.
- WorkIQ-Versionen: npm latest = **1.0.0** (GA 2026-06-16); 0.4.x veraltet, 0.2.8 antik.
  Global installiert: 0.4.0.16790 (npm-Shim). mcp-config.json pinnt npx @1.0.0 → läuft dort.
- Risiken: Erst-Login/EULA kann headless blockieren (Status via session.mcp_servers_loaded
  prüfbar); stderr-Banner bei Silent-Failure-Klassifikation herausrechnen; Underlying-CLI
  kann sich via WinGet ändern (--no-auto-update).

## 4. Seestrasse-Grundwahrheit (NUR für Tests/Verifikation — nichts einkodieren!)

Umbau Microsoft-Büro Zürich Seestrasse 356, Etage 2: 8 Meetingräume + Kabelraum 2129.
Zwei Haupt-Workstreams: (1) AV/MTR-Refresh Juni 2026 (Räume kommissioniert, «completed for
Teams use», Production-Sign-off durch Martin offen), (2) LAN-Neuverkabelung 17.–28. Aug 2026
(Contractor Ottomüller; KRITISCH: keine PO, kein Onboarding, kein Material bestellt).
Teilthemen: CHD-Displays (SEP#3235, erst NACH August-Verkabelung), Patch-Panel 2129
(6–11 Wochen Lieferzeit = Terminrisiko fürs August-Fenster), Switch cchzurseec9401
(Port-Unblock nach Change-Freeze-Ende 1. Jul, IcM 822105144), WAN/Colt-Redundanz
(Entscheidung offen seit 9. Jun), Kabelraum-Zutrittssicherheit (Lenel, Lüftungsloch-
Schwachstelle), Surface-Hub-Scope 2037, Harris-Account deaktiviert (blockiert Close-out).
≈9 offene Action Items, Treiber: Martin. Erfolgs-Messlatte für Agent Zero: erkennt die
2 Workstreams + Termine, PO als kritischsten Blocker, Patch-Panel-Risiko, Freeze-Ende 1. Jul,
und konsolidiert das alles in EINEM Projekt-Task mit Line Items statt ~8+ Einzel-Tasks.
