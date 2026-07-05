# Gremium-STATE: Agent Zero → Agency-Brain

Aktualisiert: 2026-07-05 · Branch: `feature/agency-brain`

## Status: PHASE 2 — unabhängige Planung läuft

| Schritt | Status |
|---|---|
| 1. Ist-Analyse (4 parallele Agenten) | ✅ done — Ergebnis in FACTS.md |
| 2. Unabhängige Pläne (Codex + agency) | 🔄 laufen im Hintergrund |
| 3. Debatte + Adjudikation (Master) | ⬜ |
| 4. Ratifizierung (GO/NO-GO durch agency) | ⬜ |
| 5. Implementierung (Codex, Slices) | ⬜ |
| 6. Verifikation (adversarial, Seestrasse-Testszenarien) | ⬜ |
| 7. Loop bis Ziele G1–G7 erfüllt | ⬜ |

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
