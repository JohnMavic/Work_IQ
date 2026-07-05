# Auftrag an Codex: Unabhängiger Implementierungsplan «Agent Zero → Agency-Brain»

Du bist der Heavy Lifter/Architekt in einem Gremium (Master: Claude Code, unabhängiger
Auditor: agency copilot). Deine Aufgabe JETZT: ein eigenständiger, code-basierter
IMPLEMENTIERUNGSPLAN. Noch KEINE Code-Änderungen.

## Pflichtlektüre (in dieser Reihenfolge)
1. `docs/gremium/MISSION.md` — Ziele G1–G7 und Rahmenbedingungen
2. `docs/gremium/FACTS.md` — code-verifizierte Faktenbasis
3. `docs/2026-06-11-COPILOT-CLI-AS-BRAIN-GUIDE.md` — das Architektur-Muster (Brain als
   Subprozess, Marker-Protokoll, 2-Layer-Memory, Robustheit)
4. Verifiziere die für deinen Plan tragenden FACTS-Behauptungen selbst am Code:
   `server.js` (4831 Z.), `index.html`, `Start-WorkIQ-Scan.ps1`, `docs/*_SKILL.md`,
   `tasks.json` (Struktur + Seestrasse-Beispiele).
5. Referenz-Implementierung (READ-ONLY): `E:\Task_Zero 03` — insbesondere
   `copilot-cli.js`, `brain.js` (Spawn/Robustheit), `prompts/system-prompt.md`
   (Marker-Grammatik). NICHT blind kopieren; FACTS §2 listet, was dort als
   Overengineering für Agent Zero gilt.

## Zu entscheidende Design-Fragen (mit Begründung, je EINE Empfehlung)
1. Brain-Topologie: EIN globaler Scan-Brain-Run pro Scan vs. Brain-Run pro Projekt vs.
   Hybrid. Bedenke Kosten (premiumRequests), Wall-Clock, Kontextgröße (76 Tasks).
2. Sessions: fresh `-p` pro Run mit vollem Layer-2-State-Dokument vs. `--session-id`/
   `--resume` mit Token-Ökonomie. Was rechtfertigt die Komplexität wann?
3. Welche der 4 heutigen Phasen ersetzt der Brain, welche bleiben? Was passiert mit dem
   selbst gespawnten WorkIQ-0.2.8-MCP-Client (server.js:62-477) und seinen ~700 Zeilen
   Härtung? (Ziel: Brain fragt WorkIQ selbst via geerbtem MCP-Tool.)
4. Datenmodell v5: Projekt-Task mit lineItems[] — exakte Feldliste, Migration der 76
   Bestands-Tasks (insb. der ~8 Seestrasse-Tasks), Abwärtskompatibilität der UI.
5. Marker-Grammatik für Agent Zero: minimales Set (Vorschlag: PROJECT_NEW, PROJECT_UPDATE,
   LINEITEM_NEW/UPDATE, TASK_NEW/UPDATE, SCAN_DONE, ggf. ASK_USER) + Validierungsregeln.
6. UI: Wie zeigt index.html Projekt-Tasks mit Line Items + PM-Sicht (Stand/geplant/
   Nutzer-Aktion/Probleme/Warten-auf), ohne die SPA neu zu schreiben?
7. Kostenkontrolle: Budget pro Scan, --max-autopilot-continues, MCP-Abspecken
   (--disable-mcp-server playwright etc.), Timeout-Wahl.
8. Prompt-Design: neues Brain-System-Prompt (Projektmanager-Denke!) — Struktur skizzieren.
   Der Seestrasse-Report darf NICHT als Wissen einkodiert werden; das Brain muss JEDES
   Projekt generisch verstehen.

## Deliverable
Schreibe `docs/gremium/RESULT-CODEX-PLAN.md`:
- Ziel-Architektur (Komponenten, Datenfluss, Datenmodell v5 mit Feldliste)
- Slice-Plan: nummerierte, einzeln testbare, reversible Implementierungs-Schritte
  (pro Slice: Dateien, geschätzter Umfang, Testkriterium)
- Entscheidungen zu den 8 Fragen oben, je mit Begründung
- Migrationsplan Bestandsdaten
- Testszenarien-Skizze (Seestrasse als Verifikation, generisch formuliert)
- Risiken + Gegenmaßnahmen
- Explizit: was du bewusst WEGLÄSST (Anti-Overengineering)

Arbeite gründlich, aber entscheide dich — keine Optionslisten ohne Empfehlung.
