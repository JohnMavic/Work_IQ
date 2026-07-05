# Auftrag an Codex: Batch 4 — Migration anwenden + Slice 9 (Legacy-Entfernung)

Voraussetzung: `docs/gremium/AUDIT-MIGRATION.md` Zeile 1 = `AUDIT: GO` (prüfe das
selbst; bei NO-GO: STOPP, Bericht schreiben). Specs: DECISION.md, A5/A6,
RESULT-CODEX-PLAN.md §6-Slices-8/9 + §7.

## Teil A — Apply
- Falls AUDIT-MIGRATION.md Auflagen/Korrekturen für einzelne Zuordnungen enthält:
  zuerst umsetzen (Preview regenerieren ODER Marker-Batch von Hand korrigieren —
  dokumentieren!), dann Apply.
- `scripts/migrate-projects-once.mjs --apply`: Backup + Σ-Invarianten-Gate (Abbruch
  bei Verletzung) + archived/supersededBy statt Löschung. Danach Konsistenz-Check:
  Server starten (legacy), /api/tasks liefert Projekt-Task(s) + archivierte Tasks;
  UI-relevante Felder vollständig. Commit `slice-8b: apply audited consolidation`.

## Teil B — Slice 9 (erst nach erfolgreichem Teil A)
- Reihenfolge gemäß Plan §6-Slice-9, in kleinen Commits: Legacy-Routen
  (/api/consolidate, enrich, check-update, log/correct/review, Suche) auf den
  Agency-Runner umstellen ODER als Legacy-Flag-Pfad deklarieren; erst wenn keine
  aktive Route mehr CopilotClient/askWorkIQDirect braucht: WorkIQ-0.2.8-Subprozess-
  Code + @github/copilot-sdk + @microsoft/workiq aus package.json entfernen;
  mcp.json-Umgang dokumentieren. /api/health-Contract: `wiqPid`-Feld kompatibel
  halten (null + Doku) — who-is/stop-Skripte dürfen nicht brechen (grep!).
- WICHTIG Kosten/Nutzen: Wenn eine Route ohne SDK nicht sinnvoll auf den Runner
  umstellbar ist, lieber Route hinter `AGENT_ZERO_SCAN_ENGINE=legacy`-Guard lassen
  und in RESULT dokumentieren, statt Scope aufzublähen (kein Overengineering).
- `npm test` grün; `rg "CopilotClient|askWorkIQDirect|@microsoft/workiq"` zeigt keine
  aktive Laufzeitnutzung im agency-Pfad.

Bericht `docs/gremium/RESULT-CODEX-IMPL-4.md`: Zeile 1
`BATCH4: OK` / `BATCH4: PARTIAL <was fehlt>` / `BATCH4: STOPPED <grund>`; Details knapp.
