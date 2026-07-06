# HOTFIX-Auftrag: Evidence-/Source-Links (Diagnose bestätigt, cwd = Repo-Root)

Problem (vom Master diagnostiziert, vom Nutzer live gemeldet):
1. brain/render-scan-state.js kürzt lange Links mit '...' (F8-Nebenwirkung). Der Brain
   kopiert die gekürzten Links aus dem State-Doc in Marker zurück → tasks.json enthält
   korrupte Links (Beleg: Seestrasse-Projekt hat 33 sourceRefs, nur 4 unique Links,
   Links enthalten wörtlich '/owa/...=ReadMessageItem').
2. index.html: pmStatus-Einträge tragen evidence='src-<id>' (korrekt), aber die UI
   rendert 'Evidence ↗' ohne Auflösung zur sourceRef und deren Link; die Quellenliste
   rendert 34 anonyme 'Source ↗' ohne Titel/Datum.

## Fix (Code)
A. Renderer: Links NIE gekürzt ins State-Doc. Stattdessen: für BESTEHENDE sourceRefs
   nur srcId + Titel + Datum + Absender ins State-Doc (kein Link — der Brain
   referenziert Bestehendes per srcId); volle Links nur für die Spill-Dateien falls
   nötig. Prompt (docs/AGENCY_BRAIN_SCAN_SKILL.md) entsprechend präzisieren: bestehende
   Quellen per srcId referenzieren; NEUE Quellen (aus workiq entdeckt) mit VOLLEM Link
   liefern, Links niemals abkürzen/rekonstruieren.
B. Applier-Validierung: sourceRef.link muss (wenn vorhanden) mit http(s):// beginnen
   und darf KEIN '...' enthalten; sonst Link verwerfen (sourceRef ohne Link speichern,
   Audit-Zeile), Task nicht droppen.
C. UI (index.html): (1) Evidence-Badges lösen evidence (srcId ODER Legacy-URL) gegen
   task.sourceRefs auf → href = sourceRef.link, title/tooltip = sourceRef.title + Datum;
   ohne auflösbaren Link: kein toter Link, sondern Badge 'Quelle fehlt' (dezent).
   (2) Quellenliste: statt anonymer 'Source ↗' pro sourceRef Titel + Datum + Absender
   als Linktext (Link nur wenn valide nach B-Regel), sortiert nach Datum desc,
   einklappbar bei >8.
## Fix (Daten-Reparatur, einmalig)
D. scripts/repair-source-links.mjs: für jede sourceRef mit korruptem/fehlendem Link
   ('...' enthalten, nicht-http, oder Duplikat-Link bei abweichendem Titel):
   volle Links aus den archivierten Ursprungs-Tasks rekonstruieren (Projekt-Task
   .supersedesTaskIds → archivierte Tasks .link/.additionalLinks; Matching über
   sourceTaskIds wenn vorhanden, sonst Titel-Normalisierung). Nicht rekonstruierbare:
   link=null + brainState.needsReview-Hinweis am Projekt. Backup + atomarer Write +
   Dry-Run-Ausgabe vor Apply. Auf ALLE Tasks anwenden (auch The-Circle-Projekt etc.).
   Danach Repair AUSFÜHREN (dry-run prüfen, dann apply) und Ergebnis dokumentieren.

## Tests + Abschluss
- Unit-Tests: Renderer enthält keine http-Links mehr für bestehende sourceRefs aber
  wohl deren srcIds; Applier verwirft '...'-Links; Repair-Skript-Fixture (korrupt →
  rekonstruiert, nicht rekonstruierbar → null+review).
- npm test grün. Kleine Commits (hotfix:-Präfix). Bericht docs/gremium/RESULT-FIX-LINKS.md:
  Zeile 1 'FIXLINKS: OK <repaired>/<unresolved>' oder 'FIXLINKS: PARTIAL <grund>'.
- Sicherheitsregeln: keine STOP/START-Skripte, keine Server-Neustarts (Nutzer testet
  live — er lädt die Seite selbst neu), tasks.json nur via Repair-Skript (Backup!).
