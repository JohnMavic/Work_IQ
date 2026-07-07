# Gremium-STATE: Agent Zero → Agency-Brain

Aktualisiert: 2026-07-07 · Branch: `feature/agency-brain`

## Status: BATCH 8/8B ABSCHLUSS-AUDIT **AUDIT8: PASS** (AUDIT-BATCH-8.md) — Direktvergleich der Circle-Approval-Frage nach Brain-Gedächtnis + Wahrheitshierarchie + Antwort-Disziplin. Isolierte Kind-Instanz (Port 3117, pid 42524, agency, Session-Vars gestrippt, `detectExistingInstance`→null, eigener audit8-Lock, **TASKS_FILE/JOBS_FILE auf isolierte Kopien** → echte `tasks.json` nie geöffnet). Exakte Nutzer-Frage per `POST /api/tasks/proj-zurich-circle-hublcr/log` → Job `900f4aed` (brain_run→brain_gateway→completed, ~7,5 min, WorkIQ real aufgerufen, Inbox-Scan 22 Jun–7 Jul). Antwort **kehrt die alte Fehlantwort um**: (C1) führt mit verifizierten Fakten, „verifizierte Punkte zuerst", unverifizierte klar als „Candidates — could NOT be verified" getrennt; (C2) Invoice-Freigaben ehrlich „**unverified via system of record**" + Verweis auf **MyApprovals** + „I'm not asserting a state" (ehrlicher Unverified-Pfad; kein automatisierter Edge-CDP-Portal-Check — einziger Abstand zum Ideal, nicht-blockierend); (C3) **keine** bereits erledigte Freigabe als offen behauptet — die 3 Anixter/Wesco-Invoices (PO 0101577907) NICHT als offen dargestellt („could mean already actioned … not asserting a state"); (C4) nennt den **Radon-9.3E-Sign-off** an Sorina Fota prominent (25 Jun, verbatim Ask-Quote, „Act now"); (C5) Verifikationsstatus **inline** je Aussage. Marker: `markersParsed=3`, der Radon-`userAction`-`PROJECT_UPDATE` wurde vom Batch-7-Action-Gate **gehalten** (askQuote ohne vollständige verbatim-Struktur) → reviewQueue +1, **keine** falsche userAction/Invoice-State persistiert; abgeleitete `confidence='low'` ist reines Held-Marker-Metadaten-Artefakt. **8B-Direktvergleich:** paralleler Audit-Executor (agency pid 42316 via bash) hat zeitgleich die **:3000**-Instanz gegen die **echte** tasks.json bechattet (agency-Kind 16008, ppid 38084) — meine Kopie-Isolation verhinderte jede Kreuz-Kontamination. Sicherheit: kein STOP/START, keine breiten Kills, nur eigene Kind-PID 42524 beendet, :3000 (pid 38084) + parallele agency-Prozesse + echte tasks.json/jobs.json unangetastet, Temp-Harness rückstandsfrei entfernt.

## Vorheriger Stand: BATCH 7 ABSCHLUSS-AUDIT **AUDIT7: PASS** (AUDIT-BATCH-7.md) — Wahrheitsbaum + Action-Gate + Ledger. Adversarial in BEIDE Richtungen: (Falsch-Positiv) Fall A + Fall B aus allen sichtbaren Flächen weg (0 userActions, factSheet-openActions mit removedAt+state obsolete/superseded+resolvedBy/obsoleteEvidence, 3 Renderer filtern !removedAt), verlustfrei archiviert (34 reviewQueue-Einträge + fs-b7-Status-Fakten + Ledger), Fall A unabhängig per workiq bestätigt stale (@-Mention 06.06 → "Donnerstag"=11.06 vergangen, Thread lief bis 25.06). (Falsch-Negativ, kritisch) Selbst-workiq-Suche letzte 14 Tage + Ziel-Probes auf entfernte Kandidaten: "AV sign-off requested by Patrick" hat KEINE direkte Adressierung, PO 101577907 aufgelöst 19.02.2026 → beide korrekt entfernt, kein Falsch-Negativ; einziger ambiger Rest (SAP 5735236710/Innovation-Hub, 20.02, ausserhalb Projekte+Fenster) non-blocking. Isolierter Live-Scan (Kind :3141 pid 46148, agency, Session-Vars gestrippt) → completed/partial: Ledger-Qualitäts-Gate feuerte ("missing ledger disposition for email:src-jit-039008") → appliedMarkers=0, 0 falsche Actions, Fall A/B nicht wieder da, Cursor NICHT vorgerückt (fail-safe D1/D3). Ledger 34/34 valide Dispositionen, Header "Processed up to" vorhanden. (Konflikt) disputed-Mechanismus in Code (truth-tree.validateNodeState ≥2 positions, marker-applier.syncConflictProblems "Conflicting information", index.html renderConflictPanel) + grünem Test belegt. npm test 113/113. Nutzer-Instanz :3000 (pid 40156) durchgehend unangetastet, kein STOP/START, nur eigene Kind-PID beendet, tasks.json NICHT verändert (Scan gegen isolierte Kopie), Temp-Harness rückstandsfrei entfernt.

## Vorheriger Stand: BATCH 6 + 6B ABSCHLUSS-AUDIT **AUDIT6: PASS** (AUDIT-BATCH-6.md) — Sweep sigma-safe (Σ identisch über 4 Snapshots, 0 dangling, 0 Fabrikate; 8 Marker = 7 no-op updatedAt + 1 substantiell Circle-SAP), 4/4 Stichproben per workiq-ask mailbox-exakt (Circle SAP 5735844555/Sodexo/CHF 26'645.85/PO 0101608497, Dual-MPR Basement/Dez 2026, Seestrasse Temp-WS ~18/17-28 Aug/Laith Skeik, CAB 02-Jul-Session); Owner-Explizitheit (0 Fremd-Owner in userActions, Validator+UI), Tickbox (Carry-Forward + PATCH-by-id + 2-Zustand-Reconcile), Task-Chat (EIN Gateway-Apply-Pfad code-bewiesen, 10min, Multiline, Bild-Paste `--attachment` + Guards), ENGLISH-ONLY (Prompts+UI, 0 Deutsch in generierten Feldern), regressionsfrei (npm test 104/104, tasks.json-Hash unverändert). 2 Non-Blocking-Hinweise: Sweep `lastWorkIqCalls:0` (flache Re-Verifikation) + vorbestehende CAB-Aussage "CHG0858097 completed" nur als "Scheduled" belegbar — keine Batch-6-Regression. Nutzer-Instanz :3000 (pid 26068) unangetastet, kein Kind-Server, keine STOP/START-Skripte.

## Vorheriger Stand: BATCH 5 LIVE-AUDIT **AUDIT5: PASS** (nach Gateway-Fix `71f4c9e`) — Reality-Gateway-Parser gehärtet (prosa-präfixiertes pretty-JSON + Zeilen-Verdikt-Vertrag + 1 Retry → hold-all); Fix-Live-Scan `scan-1783332440027` wandte offensichtlich zugehörige Infos auf die richtigen Projekte an (Circle +1 sourceRef/+2 factSheet, Seestrasse +1/+2, CAB unverändert), Faktensheets fortgeschrieben, 3/3 Stichproben per workiq-ask mailbox-bestätigt, 0 Fabrikate, 0 Fremd-Zuordnung, reviewQueue 18/18 mit Begründung; npm test 91/91

| Schritt | Status |
|---|---|
| 1. Ist-Analyse (4 parallele Agenten) | ✅ done — FACTS.md |
| 2. Unabhängige Pläne (Codex + agency) | ✅ done |
| 3. Debatte + Adjudikation (Master) | ✅ done — DECISION.md (D1–D10) |
| 4a. Slice-0-Gate (Default-Flags) | ✅ PASSED — workiq connected, echte Antwort, exit 0 |
| 4b. Ratifizierung durch agency | ✅ **GO-WITH-CONDITIONS** — RESULT-RATIFICATION.md, Auflagen A1–A6 |
| 4c. Auflage A1: Probe mit exakten D10-Flags | ✅ done |
| 5. Implementierung Batch 1 (Slices 1–4, Codex) | ✅ done — Commits 7fd0ecd…53c5263, 30/30 Tests |
| 5b. Verifikation Batch 1 (4-Dim-Review + Refute-Pass) | ✅ done — 19 Findings → FINDINGS-BATCH-1.md |
| 6. Implementierung Batch 2 (Fix F1–F19 + Slices 5–7) | ✅ done — batch-2 verified CLEAN (P2) |
| 7. Bestandskonsolidierung (Slice 8, Dry-Run→Audit→Apply) | ✅ done — AUDIT: GO, apply b8d4253 |
| 8. Slice 9 (Legacy-SDK/WorkIQ-0.2.8-Gating) | ✅ done — RESULT-CODEX-IMPL-4, 68/68 Tests |
| 9. **Slice 10 — Live-Verifikation (Serie C, C-1..C-6)** | ✅ **FINAL: PASS** — FINAL-VERIFICATION.md |
| 10. A5 — Engine-Default-Flip auf agency (Startskripte) | ✅ done — Start-WorkIQ-Scan.ps1 + START-AGENT-ZERO.bat |
| 11. Batch 5 — FactSheet + Reality-Check-Gateway + Datenreparatur (Codex) | ✅ done — RESULT-BATCH-5.md `BATCH5: OK`, RESULT-FIX-CIRCLE.md, npm test 85/85 |
| 12. Batch-5 Live-Audit (agency, D-Kriterien am echten Bestand) | ⚠️ historisch: AUDIT5: FAIL (2e/2f) — Gateway strict-JSON-Parser fail-closed hielt alle Belegupdates; behoben durch `71f4c9e` |
| 13. **Gateway-Fix (`71f4c9e`) + fokussiertes Re-Audit** | ✅ **AUDIT5: PASS** — AUDIT-BATCH-5.md; 2e+2f erfüllt (persistierter Delta + workiq-Mailbox 3/3), Kriterium 3 regressionsfrei (0 Fabrikate, 0 Moerken/Norway, reviewQueue 18/18 mit Grund), Kriterium 4 (auflage 4) per Tests belegt (kaputte Zeile hält nur diese; 1 Retry; dann hold-all), npm test 91/91 |
| 14. Batch 6 — Re-Verifikations-Sweep + Owner + Tickbox + Task-Chat (Codex) | ✅ done — RESULT-BATCH-6.md `BATCH6: OK markers=8 applied=8`, Commits `6b8b2dc`/`8684e68`/`0b40168` |
| 15. Batch 6b — Task-Chat Multiline + Bild-Paste + English-only (Codex) | ✅ done — RESULT-BATCH-6B.md `BATCH6B: OK`, Commits `96535fc`/`13a2c20`/`347d239`, npm test 104/104 |
| 16. **Batch 6 + 6b Abschluss-Audit (agency, 6 Kriterien am echten Bestand)** | ✅ **AUDIT6: PASS** — AUDIT-BATCH-6.md; Sweep Σ-safe + 4/4 workiq-Mailbox exakt, Owner/Tickbox/Task-Chat/English/Regression alle belegt (code+UI+tests), npm test 104/104, tasks.json unberührt; 2 Non-Blocking-Hinweise (Sweep-Tiefe `lastWorkIqCalls:0`, CAB-"completed"-Über-Assertion) |
| 17. Batch 7 — Thread-vollständige Verarbeitung + Action-Item-Gate + Ledger + disputed (Codex) | ✅ done — RESULT-BATCH-7.md `BATCH7: OK 34/0`, Repair-Sweep applied, npm test 113/113 |
| 18. **Batch 7 Abschluss-Audit (agency, beide Richtungen + isolierter Live-Scan)** | ✅ **AUDIT7: PASS** — AUDIT-BATCH-7.md; Fall A+B weg & verlustfrei archiviert (workiq-bestätigt stale), Falsch-Negativ ausgeschlossen (entfernte Kandidaten stale/nicht-adressiert per workiq), Live-Scan Quality-Gate fail-safe (0 falsche Actions, Cursor nicht vorgerückt), Ledger 34/34 valide + Header, disputed code+test; npm test 113/113, :3000 unangetastet, tasks.json unberührt |
| 19. Batch 8 + 8B — Brain-Gedächtnis (brain-learnings.md) + Wahrheitshierarchie + Antwort-Disziplin (Codex) | ✅ done — RESULT-BATCH-8.md `BATCH8: OK` / `BATCH8B: OK`, npm test 127/127 |
| 20. **Batch 8/8B Abschluss-Audit (Direktvergleich, isolierte Kind-Instanz gegen Circle-Approval-Frage)** | ✅ **AUDIT8: PASS** — AUDIT-BATCH-8.md; Antwort kehrt alte Fehlantwort um: verifiziert-zuerst, Invoices ehrlich „unverified via system of record" (MyApprovals), keine erledigte Freigabe als offen, Radon-Sign-off genannt, Verifikationsstatus inline; Action-Gate hielt unvollständigen Radon-userAction-Marker (0 falsche State-Persistenz); 8B-parallel-Executor gegen :3000/echte tasks.json ohne Kreuz-Kontamination (Kopie-Isolation); :3000 unangetastet, echte tasks.json nie geöffnet |

## Batch-5 Live-Audit (2026-07-06, AUDIT-BATCH-5.md)
- **(1) STATIC PASS:** 0 fabrizierte `turn*search*`-Links in 24 aktiven Tasks; Circle
  `proj-zurich-circle-hublcr` 0 Moerken/Norway (Kontamination reversibel in reviewQueue, 13 Einträge);
  3 Faktensheets englisch + kanonische 12-Sektionen; 5/5 Stichproben plausibel (4× workiq-Mailbox
  bestätigt, 1× Seestrasse via read-only report.html, patch-panel workiq DLP-blockiert).
- **(3) UI PASS:** `/api/tasks/:id/factsheet.html` HTTP 200, 12 Sektionen, dd.mm.yyyy-Daten +
  Evidence-Links, kein `Invalid Date`, keine Fabrikate.
- **(2) LIVE — behoben, jetzt PASS (e+f):** Ursprünglicher isolierter Scan :3101 (runId
  `scan-1783328859868`) hielt fail-closed 5/6 Marker (intermittenter ~50%-Parser-Fehler). Nach
  Gateway-Fix `71f4c9e` wandte der Fix-Live-Scan `scan-1783332440027` (Child :3104) 7 Marker sauber
  an: **Circle** sourceRefs 22→23 + factSheet 25→27, **Seestrasse** sourceRefs 33→34 + factSheet
  59→61, CAB unverändert, reviewQueue 18→18. Persistiert im Live-Bestand; 3/3 Stichproben per
  workiq-ask mailbox-bestätigt (Dual-MPR-Parcels/Andreas Arnold, Invoice 5735844555/Approved,
  Seestrasse-Temp-Workspace/Martin Hämmerli).
- **Root cause (behoben):** `brain/reality-gateway.js extractJson` — prosa-präfixiertes pretty-JSON
  defeat der 3 Extraktionspfade. Fix `71f4c9e`: Zeilen-Verdikt-Vertrag `GATEWAY_DECISION<TAB>idx<TAB>
  decision<TAB>reason` + gehärtete balanced-brace `"decisions"`-Extraktion als JSON-Fallback +
  genau 1 Reformat-Retry vor hold-all (kaputte Einzelzeile hält nur diese) + actionable
  Technik-Reason + APPLIED-statt-Intent-Telemetrie. Re-Audit-Beleg: AUDIT-BATCH-5.md.
- **Audit-Hygiene:** Nutzer-Instanz :3000 (pid 26068) unangetastet (uptime durchgehend, Lockfile
  unverändert); nur eigene Kind-PID beendet; keine STOP/START-Skripte, keine breiten Kills, keine
  Scan-Überlappung.

## Schlussstand (2026-07-05, Slice 10)
- **Alle 6 Serie-C-Kriterien bestanden** unter produktionsäquivalenter Isolation
  (FINAL-VERIFICATION.md). 3/3 isolierte Live-Scans mit `SCAN_DONE`, 0 Duplikate, bestehende
  Projekte aktualisiert, genuine neue Singles angelegt; Datenintegrität perfekt (keine Task
  gelöscht, Σ History 798→800, Σ Links 221→243).
- **Umgebungsartefakt dokumentiert (kein Agent-Zero-Defekt):** Zwei anfängliche Scan-Timeouts
  entstanden durch vererbte `AGENCY_SESSION_ID`/`COPILOT_AGENT_SESSION_ID` (Session-Bleed,
  weil die Verifikation aus einer aktiven agency-CLI-Session lief). Behoben durch Serverstart
  ohne diese Variablen (= Produktionszustand unter Task Scheduler). Optionale Härtungs-
  Empfehlung: `buildAgencyEnv()` könnte diese Variablen aus dem Brain-Kind-Env strippen.
- **A5 vollzogen:** `AGENT_ZERO_SCAN_ENGINE` defaultet jetzt in beiden Startskripten auf
  `agency` (env-Override auf `legacy` bleibt möglich; C-5 Rückschaltung verifiziert).
- **Kosten:** 45 geloggte premiumRequests (3 erfolgreiche Scans × 15); zusätzlich verbrauchten
  die 2 Timeout-Scans + 2 Proben nicht-surfaced Premium.
- **Offene, bewusste Nicht-Aktionen für P7 (Codex/Master):** README/AGENTS.md-Sync, CHANGELOG,
  Version 5.0.0; optionale `buildAgencyEnv()`-Härtung; ggf. SDK/WorkIQ-0.2.8-Dependency-
  Entfernung, sobald der Legacy-Flag-Pfad final zurückgebaut werden soll.

## Status vor Slice 10 (Referenz): PHASE 5 — RATIFIZIERT (GO-WITH-CONDITIONS)

## Auflagen aus der Ratifizierung (bindend: A1, A2)
- **A1** (vor Slice 1/5): D10-Flag-Kombination live verifizieren (`--no-default-mcps` darf workiq nicht droppen)
- **A2** (vor Slice 8/Abnahme): Abnahmetests an D6 anpassen — AV+LAN+Patch-Panel+Switch-Ports = Line Items EINES Seestrasse-Projekts; nur genuine Fremd-Themen getrennt
- **A3**: Datum-only-Evidenz ⇒ confidence ≤ medium + Datum muss auf SourceRef desselben Runs zurückführen
- **A4**: Renderer schreibt State-Doc + Spill-Dateien nach brain-work; brain-work pro Run anlegen/leeren, .gitignore, von Prozess-Cleanup ausnehmen
- **A5**: Engine-Default bleibt `legacy` bis Slice-8-Apply auditiert; Flip auf `agency` erst Slice 10
- **A6**: Höheres WorkIQ-Budget nur für den einmaligen Migrationslauf; premiumRequests separat loggen

## Adjudizierte Kernentscheide (Details in DECISION.md)
- D1: Projekt = Task (`taskType:"project"`, lineItems[], strukturiertes pmStatus mit Evidenz je Eintrag)
- D2: Brain macht Discovery selbst via geerbtem workiq-MCP; keine Signal-Inbox
- D3: 8 Marker inkl. NEEDS_REVIEW statt ASK_USER; Evidenz-Gate fail-closed
- D4: --max-autopilot-continues 0 (empirisch prüfen, SCAN_DONE-Quote messen)
- D5: --add-dir NUR brain-work\ (Brain kann tasks.json physisch nicht erreichen)
- D6: Seestrasse-Umbau = EIN Projekt mit Line Items (Nutzer-Mentalmodell bindend)
- D8: Migration Dry-Run → Audit durch agency → Apply; Invarianten Σ History/Σ Links
- D9: Slice-Reihenfolge 0–10; SDK-Entfernung erst nach Live-Verifikation

## Kernbefunde der Ist-Analyse (Kurzform, Details in FACTS.md)
- Kein Projekt-Konzept im Datenmodell; 1 Task pro E-Mail/Teams-Nachricht.
- Konsolidierung (Phase 4) erzeugt nur Vorschläge, die der geplante Scan verwirft;
  CONSOLIDATE_SKILL.md primt aktiv GEGEN Seestrasse-Gruppierung (Anti-Beispiel Z. 21).
- @github/copilot-sdk (frische Session pro Call, kein Modell-Pin, thread-scoped) statt
  agency copilot; WorkIQ 0.2.8 statt 1.0.0.
- Headless `agency copilot -p … --allow-all-tools -s` funktioniert (getestet, exit 0).
- Bug: Start-WorkIQ-Scan.ps1 sendet `days`, Server liest `scanDays` → wirkungslos.

## Entscheidungen (ratifiziert)
- (noch keine — warten auf Pläne)

## Offene Design-Fragen (für die Debatte)
1. Brain-Topologie: 1 globaler Scan-Run vs. pro Projekt vs. Hybrid
2. Sessions: fresh pro Run vs. --session-id/resume
3. Schicksal des WorkIQ-0.2.8-Eigenclients (~700 Z. Härtung)
4. Datenmodell v5 (lineItems-Feldliste) + Migration der 76 Bestands-Tasks
5. Marker-Set + Validierung
6. UI-Darstellung Projekt-Tasks (PM-Sicht) in der SPA
7. Kostenkontrolle (premiumRequests pro Scan)
8. Brain-System-Prompt (Projektmanager-Denke, generisch — kein Seestrasse-Wissen einkodieren)

## Artefakte
- `MISSION.md` — Ziele G1–G7 (Abnahmekriterien)
- `FACTS.md` — code-verifizierte Faktenbasis
- `PROMPT-CODEX-PLAN.md` / `PROMPT-AGENCY-PLAN.md` — Planungsaufträge
- `RESULT-CODEX-PLAN.md` / `RESULT-AGENCY-PLAN.md` — erwartet
- Grundwahrheit für Tests: `E:\Task_Zero 03\projects\zurich-seestrasse-av-lan-tracker\deliverable\seestrasse-status-report.html` (READ-ONLY, nichts einkodieren)
