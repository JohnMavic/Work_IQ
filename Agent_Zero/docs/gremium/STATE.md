# Gremium-STATE: Agent Zero → Agency-Brain

Aktualisiert: 2026-07-05 · Branch: `feature/agency-brain`

## Status: PHASE 5 — RATIFIZIERT (GO-WITH-CONDITIONS), A1-Probe läuft, dann Implementierung

| Schritt | Status |
|---|---|
| 1. Ist-Analyse (4 parallele Agenten) | ✅ done — FACTS.md |
| 2. Unabhängige Pläne (Codex + agency) | ✅ done |
| 3. Debatte + Adjudikation (Master) | ✅ done — DECISION.md (D1–D10) |
| 4a. Slice-0-Gate (Default-Flags) | ✅ PASSED — workiq connected, echte Antwort, exit 0 |
| 4b. Ratifizierung durch agency | ✅ **GO-WITH-CONDITIONS** — RESULT-RATIFICATION.md, Auflagen A1–A6 |
| 4c. Auflage A1: Probe mit exakten D10-Flags | 🔄 läuft |
| 5. Implementierung Batch 1 (Slices 1–4, Codex) | ✅ done — Commits 7fd0ecd…53c5263, 30/30 Tests |
| 5b. Verifikation Batch 1 (4-Dim-Review + Refute-Pass, 25 Agenten) | ✅ done — 19 bestätigte Findings (2 critical: Event-Form F1, Patch-Whitelist F2) → FINDINGS-BATCH-1.md |
| 6. Implementierung Batch 2 (Fix F1–F19 + Slices 5–7) | 🔄 Codex läuft |
| 7. Bestandskonsolidierung (Slice 8, Dry-Run→Audit→Apply) | ⬜ |
| 8. Verifikation + Loop bis G1–G7 erfüllt | ⬜ |
| 9. SDK/WorkIQ-0.2.8-Entfernung (Slice 9) + Live (Slice 10) | ⬜ |

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
