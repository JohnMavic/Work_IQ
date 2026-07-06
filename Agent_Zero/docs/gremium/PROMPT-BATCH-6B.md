# Batch 6b: Task-Chat — mehrzeilige Eingabe + Bild-Paste (Nutzer, 2026-07-06)

Erweitert Batch-6-Teil D (Task-Chat auf Agency-Brain). Referenz-Lösung existiert in
"E:\Task_Zero 03" (READ-ONLY ansehen!): Frontend-Paste-Handling + Bild-Ablage +
`--attachment <absoluter Pfad>` pro Bild an agency copilot (siehe deren brain.js
~Z.908-919 und zugehörige UI-/Upload-Teile in index.html/server.js).

## Anforderungen
1. MEHRZEILIG: Chat-Eingabe im Task-Detailpanel: Shift+Enter = Zeilenumbruch
   (Textarea wächst bis Max-Höhe, scrollt danach), Enter = Senden. Bestehende
   Send-Mechanik/Job-Fluss unverändert.
2. BILD-PASTE: Screenshots/Bilder per Copy-Paste (und Drag&Drop wenn trivial) in die
   Chat-Eingabe: Vorschau-Thumbnail(s) mit Entfernen-X vor dem Senden; Upload zum
   Server (bestehende Express-Mechanik, Größenlimit ~10MB, nur image/*), Ablage in
   einem Task-bezogenen Ordner (z.B. uploads/<taskId>/, in .gitignore); Server
   übergibt die Pfade dem Brain-Run als `--attachment` (brain-runner/agency-cli um
   attachments-Option erweitern — nur non-interactive erlaubt, siehe FACTS §3).
3. Brain-Prompt-Hinweis: angehängte Bilder gehören zum User-Prompt dieses Tasks
   (z.B. Screenshot einer Mail/eines Plans); Erkenntnisse daraus unterliegen ALLEN
   bestehenden Regeln (Zuordnungs-Checkliste, Evidenz — Bild selbst als Quelle vom
   Typ 'manual' mit Dateiname+Datum in sourceRefs, Gateway-Prüfung unverändert).
4. History: Chat-Einträge mit Bild zeigen Thumbnail in der Konversation.
5. ENGLISH-ONLY (Nutzer-Anweisung 2026-07-06, bindend): ALLE von der App generierten
   Angaben, Kommentare und Anweisungen sind ENGLISCH — unabhängig von der Sprache des
   Nutzers: pmStatus-Texte, lineItems, factSheet (bereits so), reviewQueue-Begründungen,
   History-Einträge, NEEDS_REVIEW-Fragen, Chat-Antworten des Brains, Fehlermeldungen an
   den Nutzer. Durchsetzen in AGENCY_BRAIN_SCAN_SKILL.md + Chat-/Gateway-Prompts
   (explizite Regel 'Always respond and write in English'). AUSSERDEM: UI-Labels in
   index.html auf Englisch vereinheitlichen (z.B. 'Stand heute'→'Status today',
   'Nutzer-Aktion nötig'→'Your action required', 'Warten auf'→'Waiting on',
   'Archivierte'→'Archived', Erledigt-Badges aus Batch 6C → englisch). Bestehende
   deutsche Reste in GENERIERTEN Feldern aktiver Tasks: suchen und übersetzen
   (kleines Skript/gezielte Edits, Backup; Quelltexte/Zitate in sourceRefs NICHT
   verändern). Test: Prompt-Dateien enthalten die English-Regel; UI-Snapshot ohne
   deutsche Labels.
6. Tests: Unit für attachments-Arg-Bau (Pfad-Validierung, nur innerhalb uploads/),
   Upload-Route (Typ-/Größen-Guard, Pfad-Traversal abgewehrt); UI-Verhalten als
   dokumentierte manuelle Checkliste im RESULT. npm test grün, kleine Commits.
Bericht docs/gremium/RESULT-BATCH-6B.md Zeile 1 'BATCH6B: OK' / 'BATCH6B: PARTIAL <grund>'.
Sicherheitsregeln wie immer (keine STOP/START-Skripte, Nutzer-Instanz nicht anfassen).
