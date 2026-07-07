# Batch 9 — ENTFESSELUNG (Nutzer-Direktive 2026-07-07, bindend, «Zwang»)

Direktive wörtlich: Agent Zeros Brain erhält DIE GLEICHEN Freiheiten und Rechte wie
agency copilot im Autopilot. Der Wahrheitsbaum (momentane Wahrheit) wird JEDEM Prompt
mitgegeben; aktualisiert wird nur Neues, nach Abklärung, ob ein Knoten wirklich
geändert werden muss. Ziel: Agent Zero = agency-copilot-Intelligenz × Projektgedächtnis
— dadurch BESSER als die nackte Session.

## 1. Käfig entfernen (brain/agency-cli.js, brain/brain-runner.js, Prompts)
- `--no-default-mcps` ENTFERNEN. Alle `--disable-mcp-server` ENTFERNEN. Das Brain
  bekommt alle Default-MCPs wie die interaktive Autopilot-Session (mail, teams,
  playwright, graph, workiq, …).
- WorkIQ-/Tool-Call-Hard-Kill ENTFERNEN. Nur Notbremse gegen Endlosschleifen:
  Warnung ins Log bei 40 Calls, Abbruch erst bei 150. Keine Fokus-Listen-Deckelung:
  die Stufe-1-Prüfliste ist ab jetzt HINWEIS, nie Begrenzung.
- Budякий Timeout: Scans/Deep 25 min (wie gehabt), sonst keine künstlichen Bremsen.
- Discovery ist Standard: Scans und «suche Updates»-Aufträge enumerieren Neues seit
  Ledger-Cursor bevorzugt über mail/teams-MCP (volle Bodies + ANHÄNGE: PDF/docx/xlsx
  herunterladen und lesen — Anhänge sind Pflicht-Evidenz; als Learning ergänzen).
- Stufe 1 des Chats bleibt state-only/MCP-frei — das ist ein Latenz-Feature (Antwort
  aus dem Wahrheitsbaum in <90s), kein Käfig; Stufe 2 läuft entfesselt.

## 2. Wahrheitsbaum in jedem Prompt (verifizieren, wo nötig nachziehen)
Jeder Run (Scan, Chat Stufe 1+2, Gateway, Sweeps) erhält: vollständiges factSheet
der betroffenen Tasks + pmStatus + lineItems mit Knoten-Zuständen + Ledger-Cursor +
brain-learnings. Prüfen, dass KEIN Pfad ohne diese Injektion läuft; fehlende ergänzen.

## 3. Update-Disziplin bleibt (das ist die Nutzer-Forderung «nach Abklärung»)
Schreibungen in den Wahrheitsbaum laufen weiter über Marker → Validierung → Reality-
Gateway (xhigh): Neues wird gegen den Knoten geprüft (wirklich neu? wirklich dieser
Knoten? Evidenz?) bevor es angewandt wird. Der Gateway prüft ab jetzt zusätzlich:
«Wurde verfügbare Evidenz (inkl. Anhängen) genutzt statt ignoriert?» — Nicht-Nutzen
verfügbarer Quellen ist ein Mangel.

## 4. Einziger verbleibender Guardrail (dokumentieren)
Keine externen SCHREIB-Aktionen (Mail senden, Approvals klicken) ohne explizite
Nutzer-Anweisung in derselben Konversation — Prinzip der Nutzer-Session selbst
(«Consent ≠ Freibrief»). Lesen/Recherchieren/Browsen: uneingeschränkt.

## 5. Abnahme (Direktvergleich, MUSS bestehen)
Isolierte Instanz, Chat-Auftrag an den Seestrasse-Task: «Suche in der Inbox nach
Updates und aktualisiere die PM-View-Felder.» Erfolgskriterien: (a) findet das
Kommunikationspaket von Laith Skeik vom 6. Jul inkl. PDF-ANHANG und erntet dessen
Fakten (Büro-Schließung 17.–28. Aug, AV-Räume ab 14. Aug gesperrt, PIS 31. Aug,
Temp-Workspace formal bestätigt, 24-Port-Panel-Mitigation, ½-Tag-Vorbehalt Nicolas);
(b) aktualisiert nur Knoten, die sich wirklich ändern (Gateway-Log zeigt Abklärung);
(c) Stufe-1-Antwort weiterhin <90s; (d) veraltete Einträge (z.B. verstrichenes
AV-Go-Live 1. Jul) werden erkannt und bereinigt/als überholt markiert.

Tests: Flag-Bau ohne Käfig-Flags, Notbremsen-Schwellen, Anhang-Learning vorhanden,
Injektions-Abdeckung. npm test grün, kleine Commits.
Bericht docs/gremium/RESULT-BATCH-9.md Zeile 1 'BATCH9: OK' / 'BATCH9: PARTIAL <grund>'.
Sicherheitsregeln: keine STOP/START-Skripte, laufende Instanzen nicht anfassen,
tasks.json nur via App-Pfade/Skripte mit Backup.
