# Rest-Pipeline (Master-Fahrplan, token-lean)

Kontext für JEDEN Ausführenden: MISSION.md (Ziele G1–G7), DECISION.md (D1–D10),
RESULT-RATIFICATION.md (A1–A6), TEST-SCENARIOS.md (Serien A/B/C), RESULT-CODEX-PLAN.md §6
(Slices), STATE.md (Fortschritt). Rollen: Codex=Bauen, agency copilot=Audit,
Claude-Code-Terminal (Opus 4.8, 1M)=Verifikation/Orchestrierung, Master (Fable)=Gates.

## P2 — Verifikation Batch 2 (nach Codex-Abschluss)
Opus-Session mit PROMPT-OPUS-VERIFY-2.md → schreibt FINDINGS-BATCH-2.md,
erste Zeile `VERDICT: CLEAN` oder `VERDICT: FINDINGS <n> (critical <c>)`.
Master liest NUR Zeile 1. FINDINGS>0 → Codex-Fix-Runde (Muster PROMPT-CODEX-IMPL-2 §0),
danach erneut P2 (inkrementell).

## P3 — Slice 8 bauen + Dry-Run (Codex)
PROMPT-CODEX-IMPL-3.md → Migrations-Tool + Dry-Run gegen echte tasks.json →
`docs/gremium/migration-preview.json` + RESULT. KEIN Apply. Σ-Invarianten-Test (B-6) dabei.

## P4 — Audit-Gate Migration (agency, D8/A2)
PROMPT-AGENCY-AUDIT-MIGRATION.md → prüft Preview gegen Grundwahrheit
(Task Zero 03 Seestrasse-Report, READ-ONLY) → AUDIT-MIGRATION.md, Zeile 1
`AUDIT: GO` / `AUDIT: NO-GO`. NO-GO → Findings an Codex, zurück zu P3.

## P5 — Apply + Slice 9 (Codex)
PROMPT-CODEX-IMPL-4.md → Migration anwenden (Backup! Σ-Invarianten hart),
danach Slice 9 (SDK/WorkIQ-0.2.8-Entfernung, Health-Contract beachten). Tests grün.

## P6 — Live-Verifikation Slice 10 (Opus-Session führt, agency prüft C-4)
PROMPT-OPUS-LIVE-VERIFY.md → Flag auf agency, echter Scan ×2, Serie C abarbeiten
(C-1..C-6; C-4-Stichprobe via agency copilot mit workiq), UI-Check (Server + Browser
oder DOM-Prüfung), FINAL-VERIFICATION.md mit Checkliste + `FINAL: PASS/FAIL <details>`.
FAIL → kleinste Korrektur via Codex, Loop (nur betroffene Kriterien erneut).

## P7 — Abschluss
Codex: STATE.md finalisieren, README/AGENTS.md-Sync, CHANGELOG, Version 5.0.0.
Master: Kurzbericht an Nutzer. Flag-Default bleibt gemäß A5-Logik erst nach
bestandener Live-Verifikation auf agency.

## Standard-Kommandos
- Codex: `codex exec --dangerously-bypass-approvals-and-sandbox -C "E:\Work_IQ\Agent_Zero" -m gpt-5.5 -c model_reasoning_effort="xhigh" "<Auftrag: Lies <BRIEF> und führe aus>"`
- agency: `AGENCY_RING=Prod AGENCY_NO_UPDATE_CHECK=1 agency copilot -p "<Auftrag>" --allow-all-tools --no-ask-user -s --model claude-opus-4.8 --effort max --add-dir "E:\Work_IQ\Agent_Zero" [--add-dir "E:\Task_Zero 03"] --no-auto-update`
- Opus-Terminal: `claude -p "<Auftrag: Lies <BRIEF> und führe aus>" --model claude-opus-4-8 --dangerously-skip-permissions --add-dir "E:\Task_Zero 03"` (cwd = E:\Work_IQ\Agent_Zero)
- Alle Läufe im Hintergrund; Ergebnis-Dateien in docs/gremium/; Master liest nur Zeile 1 / RESULT-Kurzfassungen.
