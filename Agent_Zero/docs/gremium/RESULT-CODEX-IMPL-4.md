BATCH4: OK

# Batch 4 Result — Apply + Slice 9

## Teil A — Auditierter Apply

- Gate geprüft: `docs/gremium/AUDIT-MIGRATION.md` Zeile 1 = `AUDIT: GO`.
- Preview-Hash vor Apply geprüft: `F04E7F7E82E6EBC64C1C1E4D3090EC05356829CAA987C924A6AFBDD2DB9D11F8` (match zum Audit).
- `node scripts/migrate-projects-once.mjs --apply` erfolgreich:
  - appliedMarkers: 11
  - archivedTaskIds: 56
  - history: 739 -> 798
  - links: 106 -> 221
  - tasks: 76 -> 79
  - deletedTaskIds: []
- Konsistenz lokal/API verifiziert: 79 Tasks, 3 aktive Projekt-Tasks, 56 archivierte Ursprungstasks, 18 Line Items; Projektfelder `lineItems`, `pmStatus`, `sourceRefs`, `supersedesTaskIds`, `additionalLinks`, `brainState` vorhanden.
- Commit: `b8d4253 slice-8b: apply audited consolidation` (empty commit, weil `tasks.json`/Backups bewusst ignorierte lokale Daten sind).

## Teil B — Slice 9

- Legacy-SDK-/WorkIQ-Routen als `AGENT_ZERO_SCAN_ENGINE=legacy`-Pfad deklariert:
  `/api/scan`, `/api/tasks/:id/enrich`, `/api/tasks/:id/check-update`, `/api/consolidate`,
  `/api/tasks/merge`, `/api/tasks/:id/log`, `/api/tasks/:id/review`, `/api/tasks/:id/correct`.
- `kind:"merge"` und `kind:"consolidate"` werden im Agency-Modus vor Job-Enqueue abgelehnt.
- Persistent WorkIQ-0.2.8-Subprozess startet nur noch bei Legacy-Engine; im Agency-Modus bleibt `wiqPid:null`.
- `/api/health` bleibt kompatibel und liefert weiter `wiqPid`; zusätzlich `scanEngine`.
- `Start-WorkIQ-Scan.ps1` und `who-is-agent-zero.ps1` tolerieren `wiqPid:null` bei `scanEngine:"agency"`.
- `mcp.json` ist als Legacy-SDK-only dokumentiert; Agency nutzt die geerbte Copilot-MCP-Konfiguration.
- Dependencies `@github/copilot-sdk` und `@microsoft/workiq` bleiben absichtlich erhalten, weil der erlaubte Legacy-Flag-Pfad weiter existiert. Entfernung ist erst korrekt, wenn dieser Pfad nach P6/Slice 10 gelöscht wird.
- Commits:
  - `0245076 slice-9: gate legacy SDK routes`
  - `f335a84 test: assert legacy route guards`

## Verifikation

- `node --check server.js`: OK
- `npm test`: OK, 68/68 Tests grün
- Neuer Unit-Test `tests/unit/legacy-route-guards.mjs` belegt statisch:
  - jeder Legacy-Endpunkt guardet vor `CopilotClient`/`askWorkIQDirect`
  - WorkIQ-Subprozess-Start ist Legacy-only
  - Health/Scheduler/Diagnose tolerieren `wiqPid:null`
  - `mcp.json` dokumentiert Legacy-only
- `rg "guardLegacyRoute|new CopilotClient|askWorkIQDirect|@microsoft/workiq|startWorkIQMCP|wiqPid"`: Treffer bleiben in Legacy-Guard-Blöcken, Legacy-Konfiguration/Dependencies oder den Guard-Tests; keine aktive Agency-Pfad-Nutzung.

Hinweis: Eigene Live-Server-Guard-Tests mit Agency-Engine wurden nach Nutzeranweisung übersprungen; P6 übernimmt Live-Verifikation.
