# Gremium-Mission: Agent Zero → Agency-Copilot-Brain + Projekt-Konsolidierung

Branch: `feature/agency-brain` · Datum: 2026-07-05 · Auftraggeber: Martin (Endnutzer)

## Problem (vom Nutzer formuliert)
Agent Zero findet E-Mails, aber der Nutzen ist gering: Ein reales Projekt (z.B. Umbau
Microsoft Office «Zurich Seestrasse», auch «Zurich See» genannt) zerfällt in viele einzelne
Tasks. Die Info über 10 Tasks verteilt zu lesen ist genauso anstrengend wie 10 E-Mails in
Outlook zu lesen → keine Erleichterung.

## Ziel (messbar, = Abnahmekriterien)
- **G1 Engine:** Agent Zero nutzt headless `agency copilot` als Brain (Prozess-Spawn nach
  Guide `docs/2026-06-11-COPILOT-CLI-AS-BRAIN-GUIDE.md`), NICHT mehr `@github/copilot-sdk`.
  WorkIQ-Zugriff über die vom CLI-Kind geerbte `~/.copilot/mcp-config.json` (Pin ≥1.0.0),
  nicht mehr über den selbst gespawnten 0.2.8-MCP-Subprozess.
- **G2 Projekt-Konsolidierung:** Ein Projekt = EIN Task mit Line Items (Teilthemen).
  Verstreute bestehende Tasks desselben Projekts werden zusammengeführt; neue E-Mails/Chats
  aktualisieren bestehende Line Items statt neue Tasks zu erzeugen (Supersede statt Duplikat).
- **G3 Projektmanager-Sicht pro Projekt-Task:** Stand heute · Was ist geplant (Termine) ·
  Wo muss der NUTZER aktiv werden · Probleme · mögliche Probleme/Risiken · Worauf warten wir.
  In der UI auf einen Blick erfassbar.
- **G4 Laufende Aktualisierung:** Jeder Scan prüft neue Signale gegen das bestehende
  Projektverständnis und aktualisiert es; Statusänderungen brauchen Evidenz (Quell-Links).
- **G5 Seestrasse-Verifikation:** Agent Zero rekonstruiert das Seestrasse-Projekt eigenständig
  aus E-Mails/Teams (via WorkIQ). Die Grundwahrheit (`seestrasse-status-report.html` in
  Task Zero 03) dient NUR der Verifikation — nichts daraus wird in Agent Zero einkodiert.
- **G6 Robustheit:** Timeout+Salvage, Silent-Failure-Recovery, strikter Erfolgsbegriff
  (exit 0 + Text), atomare Persistenz. Keine Regression bestehender Kernfunktionen
  (Task-CRUD, UI, geplanter Scan 07:00/11:00).
- **G7 Kein Overengineering:** Guide-Skeleton als Basis (~150–300 Zeilen Brain-Modul),
  Batch-only-Marker-Parsing, tasks.json bleibt der Store, keine neuen Frameworks/DBs.

## Harte Rahmenbedingungen
- Node.js/Express + Single-File-Frontend bleiben. Windows 11, kein Docker.
- Der Nutzer-Fokus ist das Produkt: «Das ist der Stand, das ist geplant, hier musst DU
  aktiv werden, hier gibt es (potenzielle) Probleme.»
- Änderungen reversibel; Bestandsdaten (76 Tasks) werden migriert, nicht verworfen.
- Kosten beachten: agency-Runs verbrauchen Premium-Requests → wenige, große Brain-Runs
  statt vieler kleiner Sessions.

## Faktenbasis
Code-verifizierte Analyse in `docs/gremium/FACTS.md` (Agent Zero heute, Task Zero 03
Referenzmuster, agency-CLI-Fähigkeiten, WorkIQ-Versionen). Behauptungen daraus dürfen
angezweifelt und müssen dann am Code verifiziert werden.
