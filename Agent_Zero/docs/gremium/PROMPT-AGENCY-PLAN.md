# Auftrag an Agency Copilot: Unabhängiger Plan + adversariale Risiko-Sicht

Du bist der UNABHÄNGIGE AUDITOR in einem Gremium (Master: Claude Code, Heavy Lifter:
Codex). Deine Aufgabe JETZT: ein eigenständiger, code-basierter Plan für den Umbau von
Agent Zero — gebildet aus DEINER eigenen Analyse, nicht aus fremden Vorlagen. Noch KEINE
Code-Änderungen.

## Pflichtlektüre
1. `E:\Work_IQ\Agent_Zero\docs\gremium\MISSION.md` — Ziele G1–G7
2. `E:\Work_IQ\Agent_Zero\docs\gremium\FACTS.md` — Faktenbasis (darfst du anzweifeln,
   dann am Code verifizieren)
3. `E:\Work_IQ\Agent_Zero\docs\2026-06-11-COPILOT-CLI-AS-BRAIN-GUIDE.md` — Architektur-Muster
4. Eigene Stichproben im Code: `E:\Work_IQ\Agent_Zero\server.js`, `index.html`,
   `docs/*_SKILL.md`, `tasks.json` (Seestrasse-Task-Beispiele ansehen!)
5. Referenz (READ-ONLY): `E:\Task_Zero 03` (copilot-cli.js, brain.js, prompts/system-prompt.md)

## Dein Fokus (zusätzlich zum Plan): Sei adversarial
- Wo wird der naheliegende Umbau SCHEITERN? (Auth/EULA headless, Premium-Request-Kosten
  pro Scan, Autopilot-Continuation-Eigenheiten, 32-KB-Limit bei 76-Task-State-Dokument,
  WorkIQ-Antwortqualität für Projekt-Rekonstruktion, UI-Regression der SPA)
- Was am Task-Zero-03-Muster ist für Agent Zero die FALSCHE Abstraktion?
- Wie verhindern wir, dass das Brain halluzinierte Projekt-Status schreibt?
  (Evidenz-Pflicht, fail-closed Marker-Validierung, Konfidenz)
- Migration: Was kann beim Zusammenführen der ~8 Seestrasse-Bestands-Tasks in einen
  Projekt-Task verloren gehen (History, Links, noMergeWith)?
- Testbarkeit: Wie verifizieren wir G2–G5 OBJEKTIV, ohne den Seestrasse-Report in die
  App zu kodieren?

## Deliverable
Schreibe `E:\Work_IQ\Agent_Zero\docs\gremium\RESULT-AGENCY-PLAN.md`:
- Deine Ziel-Architektur in Kurzform (Brain-Topologie, Sessions, Datenmodell, Marker,
  UI-Ansatz) — mit je EINER Empfehlung, keine Optionslisten
- Slice-Plan (nummerierte, testbare, reversible Schritte)
- Adversariale Risikoliste: konkrete Fehlerszenarien + Gegenmaßnahme + wie man sie testet
- Abnahme-Testszenarien für G2–G5 (generisch, Seestrasse nur als Verifikationsfall)
- Explizite Anti-Overengineering-Liste (was bewusst NICHT gebaut wird)
