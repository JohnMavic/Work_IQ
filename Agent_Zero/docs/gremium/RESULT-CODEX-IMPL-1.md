# RESULT-CODEX-IMPL-1

Stand: 2026-07-05  
Branch: `feature/agency-brain`

## Ergebnis

Batch 1 ist umgesetzt: Slices 1-4 sind implementiert, jeweils mit Unit-Tests, grünem
`npm test` und einem Slice-Commit.

Commits:
- `7fd0ecd` `slice-1: add agency brain runner skeleton`
- `50c2634` `slice-2: add atomic tasks writes and v5 migration`
- `5515779` `slice-3: add agency brain marker parser and applier`
- `941f1ca` `slice-4: add agency brain prompt and state renderer`

Letzter Testlauf:
- Befehl: `npm test`
- Ergebnis: 30 Tests bestanden, 0 fehlgeschlagen.

## Slice 1 - Brain-Runner-Skeleton

Dateien:
- `brain/agency-cli.js` (91 Zeilen): `where.exe agency.exe`-Auflösung, memoized;
  D10-Argumente, Modell/Effort/Context-Pin, `COPILOT_MODEL`, Caller-Arg-Dedupe,
  `--add-dir brain-work`, `--disable-mcp-server playwright`, `--disable-mcp-server
  github-mcp-server`.
- `brain/brain-runner.js` (283 Zeilen): Spawn-Envelope, NDJSON-Line-Buffering,
  `assistant.message`-Aggregation, Tool-Execution-Zähler, WorkIQ-Hard-Kill,
  Timeout/Salvage, Single-Settle, Silent-Failure-Erkennung mit Agency-Banner-Residual,
  >16KB File-Context-Fallback, `brain-work`-Cleanup.
- `.gitignore` (Zeilen 4, 12): `tests/unit/.tmp-*/`, `brain-work/`.
- `tests/unit/brain-runner.mjs` (192 Zeilen).

Testnamen:
- `brain runner resolves success from exit 0 plus assistant.message text`
- `brain runner treats exit 0 plus empty assistant text as failure`
- `brain runner salvages timeout when assistant text has at least 200 bytes`
- `brain runner marks non-zero exit with empty stdout and banner-only stderr as silent failure`
- `brain runner spills bootstrap over 16 KB to per-run file and cleans it up`
- `brain runner reports tool.execution callbacks and WorkIQ counters`

## Slice 2 - Atomic Write + v5-Migration

Dateien:
- `brain/tasks-v5.js` (120 Zeilen): `writeJsonFileAtomic` mit tmp+fsync+rename und
  max. 3 rotierenden `.bak`; additive `migrateToV5`; `migrateTasksFileToV5` mit
  `tasks.json.v4-<timestamp>.bak`.
- `server.js` (geändert an Zeilen 11, 961-966, 1299-1305): bestehende
  `writeTasks`-Aufrufe laufen über `writeTasksAtomic`; `migrateToV5()` ist vorbereitet,
  aber nicht im Startup-Block aktiviert.
- `tests/unit/tasks-v5-migration.mjs` (119 Zeilen).

Testnamen:
- `migrateToV5 migrates a v4 fixture additively and preserves task count`
- `migrateToV5 is idempotent`
- `migrateToV5 does not lose existing task fields`
- `migrateTasksFileToV5 writes backup before migration and round-trips JSON`
- `writeJsonFileAtomic rotates at most three .bak files`

## Slice 3 - Marker-Parser + Applier

Dateien:
- `brain/marker-parser.js` (43 Zeilen): Marker-Set aus D3, daraus abgeleitete Regex,
  fence-aware Parsing, Single-Line-JSON.
- `brain/marker-applier.js` (546 Zeilen): fail-closed Validierung, Referenzauflösung
  gegen Bestand und Batch-SourceRefs, Evidenz-Gate, A3 Date-only-Confidence-Cap,
  Projektanlage, Projektupdate, Line-Item-Anlage/Update, Task-Anlage/Update,
  `NEEDS_REVIEW`, `SCAN_DONE`, Superseding via `archived:true`/`supersededBy`, Audit
  als JSONL nach `logs/brain-audit.jsonl`.
- `tests/unit/brain-markers.mjs` (258 Zeilen).

Testnamen:
- `valid marker batch creates a project task with sourceRefs and lineItems`
- `unknown task reference is dropped and audited`
- `parser ignores markers inside fenced code blocks`
- `status-changing TASK_UPDATE without evidence is dropped`
- `superseded source tasks are archived but not deleted`
- `NEEDS_REVIEW persists task review state and root reviewQueue entries`
- `date-only evidence caps confidence to medium when traced to a SourceRef`
- `date-only evidence must resolve to an existing or same-batch SourceRef`

## Slice 4 - Brain-System-Prompt + State-Renderer

Dateien:
- `docs/AGENCY_BRAIN_SCAN_SKILL.md` (73 Zeilen): PM-Brain-Rolle, Wahrheitshierarchie,
  D6-Projektgranularität, Evidence-Regeln, A3-Date-only-Regel, WorkIQ-Budget 10,
  State-/Spill-Datei-Regeln, exakte Marker-Grammatik, Self-Check.
- `brain/render-scan-state.js` (179 Zeilen): kompakte Projektion offener Projekte und
  Single-Tasks, archivierte Tasks nur als ID-Liste, `lastScan`-Anker, kontrollierte
  Kürzung, History-Spill-Dateien nach `brain-work`, `brain-work`-Cleanup.
- `tests/unit/render-scan-state.mjs` (122 Zeilen).

Testnamen:
- `renderScanState includes all open project and single tasks`
- `renderScanState stays under budget for a 76-task fixture while keeping every open task id`
- `renderScanState writes state and spill files into a clean brain-work directory`
- `brain prompt and renderer do not encode project-specific verification facts`

## Abweichungen / Begründung

- `migrateToV5()` ist bewusst nicht beim Boot aktiviert. Das folgt der Batch-1-Regel:
  Migration erst in Slice 5 aktivieren.
- Die v5- und Atomic-Write-Logik liegt zusätzlich in `brain/tasks-v5.js`, damit sie
  hermetisch testbar ist. `server.js` ist trotzdem verdrahtet und nutzt den atomischen
  Writer über `writeTasks`.
- Der Applier schreibt noch nicht selbst `tasks.json`; er mutiert und returned eine
  validierte Datenstruktur plus Audit. Das hält den geplanten Slice-5-Orchestrator als
  einzigen State-Owner intakt.
- Es wurde keine Scan-Job-, Scheduler- oder UI-Verdrahtung vorgezogen.
- Live-Agency/WorkIQ wurde in diesem Batch nicht ausgeführt; Slice 1 ist absichtlich mit
  Fake-Spawn getestet.

## Offen

- Slice 5: Agency-Brain-Scan hinter Feature-Flag verdrahten und `migrateToV5()` aktivieren.
- Slice 6+: Scheduler/Job-Umschaltung, UI-Projektansicht, Bestandskonsolidierung und
  spätere Legacy-SDK-Entfernung.
- Live-Verifikation mit realer WorkIQ-Session steht weiterhin für die späteren Slices an.
