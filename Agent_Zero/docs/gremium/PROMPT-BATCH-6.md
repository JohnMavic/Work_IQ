# Batch 6: Re-Verifikations-Sweep · Owner-Klarheit · Erledigt-Tickbox · Task-Chat

Specs gelten weiter: DECISION.md, RATIFY-BATCH-5.md-Auflagen (Gateway-Verträge!),
AGENCY_BRAIN_SCAN_SKILL.md-Disziplin, Anti-Overengineering. Nutzer-Auftrag 2026-07-06.

## A. Einmaliger Re-Verifikations-Sweep (Datenreparatur, alle aktiven Tasks)
`scripts/reverify-tasks.mjs` (dry-run/apply, Backup, atomar): Für JEDEN aktiven Task
(Projekte + Singles) prüft ein Brain-Run (mit Reality-Gateway) jede Aussage in
pmStatus/lineItems/factSheet/summary: (1) durch sourceRefs/Mailbox-Evidenz gedeckt?
(2) richtige Projekt-Zuordnung (Land/Org-Check)? (3) aktuell vs. veraltet?
Unbelegbares/Falsches → korrigieren oder entfernen→reviewQueue (referenziell integer,
reversibel, Muster 6b). workiq-Budget dafür erhöht (wie A6-Migrationslauf).
Batchweise (z.B. 5 Tasks pro Run) gegen Kontext-Überlauf. Ergebnis-Statistik in RESULT.

## B. Owner-Explizitheit (userActions = NUR der App-Nutzer)
- pmStatus.userActions: Einträge bekommen `owner:"user"` implizit — dort darf NUR
  stehen, was MARTIN (App-Nutzer) selbst tun muss. Prompt + Gateway-Prüffrage:
  «Ist das wirklich eine Aktion des NUTZERS — oder eines anderen Projektmitglieds?»
- Aktionen anderer: in lineItems/factSheet 'Open Actions' mit explizitem `owner`
  (Name/Rolle). UI zeigt Owner überall sichtbar an (z.B. 'Du' fett vs. Name).
- Sweep A klassifiziert bestehende userActions entsprechend um.

## C. Erledigt-Tickbox (lean, zwei Zustände statt Regelwerk)
- Datenmodell userAction-Eintrag: + `userMarkedDoneAt: ISO|null`.
- UI: Checkbox je Nutzer-Aktion. Angehakt → Badge «von dir erledigt am dd.mm.yyyy —
  Bestätigung ausstehend», raus aus der roten Aktiv-werden-Zone (einklappbare Sektion
  'Von dir erledigt'). Abhakbar rückgängig.
- Scan-Reconcile (Prompt + Marker): markierte Aktionen werden weiter beobachtet;
  Evidenz bestätigt → Aktion geschlossen (mit Beleg, History-Eintrag); Evidenz
  widerspricht (Thema weiterhin/wieder offen) → zurück in die Aktiv-Zone mit Hinweis
  «am dd.mm.yyyy als erledigt markiert, neue Signale zeigen offen» + Evidenz.
  KEINE weiteren Zustände/Regeln.
- API: PATCH-Endpoint für userMarkedDoneAt (bestehende Task-PATCH-Mechanik nutzen).

## D. Task-Chat auf Agency-Brain umverdrahten
- Bestehenden Legacy-Pfad /api/tasks/:id/log (SEARCH_SKILL/SDK) ersetzen durch
  task-scoped Brain-Run: Kontext = State-Doc-Ausschnitt NUR dieses Tasks (factSheet
  vollständig, pmStatus, lineItems, letzte History, sourceRefs) + User-Prompt.
  Brain entscheidet selbst über Tool-Einsatz (workiq etc. via geerbte MCPs).
- Antwort: Chat-Text an UI (bestehender Konversations-Fluss) + optionale Marker
  (gleiche Grammatik) für Task-Updates — Marker laufen durch DENSELBEN Validator +
  Reality-Gateway wie Scans (kein zweiter Apply-Pfad!). Kürzen/Erweitern/Korrigieren
  des Tasks damit möglich.
- Timeout kürzer (10 min), Job-/SSE-Mechanik des bestehenden Log-Jobs weiterverwenden.
- UI: bestehendes Eingabefeld im Detailpanel bleibt der Einstieg.

## Tests
Unit: B-Klassifikation (Fremd-Owner-Aktion darf nicht in userActions), C-Reconcile
(bestätigt→zu, widersprochen→zurück mit Hinweis, markiert→nicht in Aktiv-Zone),
D-Marker-Pfad (Chat-Marker laufen durch Gateway; invalider Chat-Output mutiert nichts).
Serie B-Fixture-Erweiterung wo passend. npm test grün. Sweep A: dry-run-Statistik
vor apply prüfen (keine Verluste: Σ-Invarianten).

## Sicherheits-/Arbeitsregeln
Wie immer: keine STOP/START-Skripte, keine breiten Kills, tasks.json nur via Skripte
mit Backup, Nutzer-Instanz nicht anfassen, kleine Commits.
Bericht docs/gremium/RESULT-BATCH-6.md Zeile 1 'BATCH6: OK <sweep-statistik>' oder
'BATCH6: PARTIAL <grund>'.
