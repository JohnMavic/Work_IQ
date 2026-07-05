# Auftrag (Claude Opus 4.8 Terminal-Session): Slice 10 — Live-Verifikation + Loop

Rolle: Verifikations-Orchestrator des Gremiums. Du führst die Live-Abnahme durch,
koordinierst Hilfsagenten selbst und loopst bis PASS oder bis ein Umgebungslimit
sauber dokumentiert ist. Repo: E:\Work_IQ\Agent_Zero (Branch feature/agency-brain).
Specs: TEST-SCENARIOS.md (Serie C = Checkliste), MISSION.md, DECISION.md, NEXT-STEPS.md.

## Ablauf
1. Vorbedingungen: RESULT-CODEX-IMPL-4.md Zeile 1 = BATCH4: OK; npm test grün.
2. Server mit `AGENT_ZERO_SCAN_ENGINE=agency` starten (env nur für diesen Prozess;
   Single-Instance-Lock beachten — ggf. laufende Instanz sauber via stop-agent-zero.ps1).
3. C-Serie abarbeiten und JEDES Kriterium mit Beleg abhaken:
   - Scan-Job Nr. 1 triggern (POST /api/jobs {kind:"scan"}), SSE/Job-Ende abwarten
     (bis 30 min), Job-Result + tasks.json-Delta auswerten → C-1 (falls Slice-8-Apply
     schon konsolidiert hat: prüfen, dass der Scan das Projekt AKTUALISIERT statt
     dupliziert), C-5 (SCAN_DONE, Laufzeit, premiumRequests/workiqCalls geloggt,
     kein 0.2.8-Subprozess: Prozessliste prüfen).
   - Scan-Job Nr. 2 (einige Minuten später) → C-3 (kein Duplikat, Updates statt neue Tasks).
   - C-2: pmStatus des Seestrasse-Projekt-Tasks gegen die Grundwahrheit
     (E:\Task_Zero 03\...\seestrasse-status-report.html, READ-ONLY) menschlich-kritisch
     vergleichen: kritischster Blocker in userActions/problems? Terminrisiko in risks?
     Wartebedingungen mit Datum? Ausführungsfenster erfasst? Evidenz überall?
   - C-4: Delegiere die 5er-Stichprobe an agency copilot (Kommando in NEXT-STEPS.md;
     er verifiziert Aussagen per workiq-ask gegen die Mailbox) und werte sein Urteil aus.
   - C-6: UI prüfen — Server-Seite: HTML/JS-Analyse + DOM-Test (node/playwright ist als
     devDependency da): Projekt-Karte, 6 PM-Sektionen, archived-Toggle, Suche über
     lineItems, Alt-Task-Rendering. Screenshot optional.
4. Loop: Bei FAIL eines Kriteriums → Ursache klassifizieren (Prompt/Validierung/
   Renderer/WorkIQ-Datenlücke/UI) → kleinste Korrektur SELBST einbauen wenn trivial
   (Prompt-Text, UI-Detail) oder via Codex-Kommando (NEXT-STEPS.md) wenn substanziell →
   nur betroffene Kriterien erneut. Max 4 Loop-Runden; WorkIQ-Datenlücken als
   Umgebungslimit dokumentieren statt wegoptimieren. Commits pro Fix (`live-fix: ...`).
5. Abschluss bei PASS: A5-Finalisierung — Scheduler-/Startskripte so setzen, dass der
   geplante Scan mit agency-Engine läuft (Default-Flip dokumentieren); finaler Commit.
6. Schreibe docs/gremium/FINAL-VERIFICATION.md: Zeile 1 `FINAL: PASS` oder
   `FINAL: FAIL <kriterien>`; dann C-1..C-6-Checkliste mit Belegen (Job-IDs, Zahlen,
   Zitate), Loop-Historie, Restpunkte/Umgebungslimits, Kosten (premiumRequests gesamt).
   Aktualisiere STATE.md (Tabelle + Schlussstand).

Regeln: tasks.json nur über die App/Tools mutieren (nie von Hand); Backups nicht
löschen; ehrlich berichten (FAIL ist ein gültiges Ergebnis); keine Seestrasse-Fakten
in App/Prompts einkodieren.
