# Auftrag an Agency Copilot (Auditor): Audit-Gate Bestandskonsolidierung (D8/A2)

Prüfe adversarial den Dry-Run `E:\Work_IQ\Agent_Zero\docs\gremium\migration-preview.json`
(+ RESULT-CODEX-IMPL-3.md) BEVOR irgendetwas angewandt wird.

Grundwahrheit (READ-ONLY, NUR Messlatte):
`E:\Task_Zero 03\projects\zurich-seestrasse-av-lan-tracker\deliverable\seestrasse-status-report.html`
+ echte Task-Titel/Summaries in `E:\Work_IQ\Agent_Zero\tasks.json` (nie mutieren).

Prüfkriterien (TEST-SCENARIOS.md C-1 + A2/D6):
1. Seestrasse-Umbau = EIN Projekt-Task-Vorschlag; AV/MTR + LAN-Verkabelung +
   Patch-Panel/Kabelraum + CHD (+ Switch-Ports/WAN wenn Evidenz) als LINE ITEMS darin.
2. Genuine Fremd-Themen (andere Räume/Gebäude-Vorhaben, unabhängige Incidents, fremde
   PO-Approvals) NICHT hineingezogen (Übermerge-Check R5).
3. Kein Bestands-Task geht verloren: jeder aktive Task ist genau einmal zugeordnet
   ODER bleibt Single ODER steht in unassigned/NEEDS_REVIEW.
4. Invarianten: historySum/linkSum After ≥ Before; archiviert statt gelöscht.
5. pmStatus/userActions-Vorschläge evidenzgestützt (Stichprobe 5 Aussagen gegen die
   Quell-Links/Daten in tasks.json; bei Unsicherheit workiq-ask nutzen — du hast Zugriff).
6. Keine halluzinierten Projekte/Line Items ohne Quellbezug.

Schreibe `E:\Work_IQ\Agent_Zero\docs\gremium\AUDIT-MIGRATION.md`:
Zeile 1 `AUDIT: GO` oder `AUDIT: NO-GO`. Danach: je Kriterium PASS/FAIL + Belege;
bei NO-GO konkrete, umsetzbare Korrekturanweisungen für Codex (welcher Task falsch
zugeordnet, was fehlt). Ändere selbst NICHTS am Repo außer dieser Datei.
