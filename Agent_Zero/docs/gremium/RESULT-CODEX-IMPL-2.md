# RESULT-CODEX-IMPL-2

Stand: 2026-07-05  
Branch: `feature/agency-brain`

## Ergebnis

Batch 2 ist umgesetzt:

- Fix-First aller 19 Findings aus `FINDINGS-BATCH-1.md`
- Slice 5: Agency-Brain-Scan hinter Feature-Flag, v5-Migration beim Startup aktiv
- Slice 6: Scheduler auf Scan-Job-API, `days`/`scanDays`-Bugfix, Agency-Phasenlabels
- Slice 7: Projekt-Task-Karten, PM-Detailansicht, Archiv-Toggle und erweiterte Suche

Commits:

- `4c11b08` `slice-fix: batch-1 review findings F1-F19`
- `0b4947e` `slice-5: add agency brain scan path`
- `a4ffa80` `slice-6: route scheduler through scan jobs`
- `8a9fff7` `slice-7: render project task PM view`

Letzter Testlauf:

- Befehl: `npm test`
- Ergebnis: 59 Tests bestanden, 0 fehlgeschlagen.

## Fix-First F1-F19

Dateien:

- `.gitignore`
- `server.js`
- `docs/AGENCY_BRAIN_SCAN_SKILL.md`
- `brain/brain-runner.js`
- `brain/marker-parser.js`
- `brain/marker-applier.js`
- `brain/render-scan-state.js`
- `brain/tasks-v5.js`
- `tests/unit/brain-runner.mjs`
- `tests/unit/brain-markers.mjs`
- `tests/unit/render-scan-state.mjs`
- `tests/unit/tasks-v5-migration.mjs`

Umgesetzt:

- Runner liest reale `assistant.message`-Events mit `data.content`, trennt Messages per Newline, promotet Delta-only-Turns, nutzt `StringDecoder`, zählt WorkIQ nur aus Tool-Identitätsfeldern und klassifiziert Timeouts nicht als Silent Failure.
- `runBrain()` wischt `brain-work` nicht mehr automatisch; Cleanup-Verantwortung liegt beim Renderer/Scan-Orchestrator.
- Marker-Parser ignoriert Backtick- und Tilde-Fences.
- `TASK_UPDATE` und `LINEITEM_UPDATE` haben Patch-Whitelists; destruktive Felder werden gedroppt.
- Evidenzindex wird nur aus validierten Markern gespeist; `TASK_UPDATE` kann neue `sourceRefs` einführen und persistiert sie.
- Prompt und Renderer sind zur `TASK_UPDATE`-SourceRef-Grammatik und zur vollständigen `PROJECT_UPDATE.pmStatus`-Replace-Semantik synchronisiert.
- Renderer kürzt Links, rendert SourceRef-IDs für Singles, schreibt History nur bei `writeFiles:true`, spillt vollständige `pmStatus`/verdeckte Line Items und bleibt bei 76 Long-Link-Tasks im Budget.
- Atomic Writer hat Windows-Rename-Retry, Backup-Copy-Fehler blockieren den Hauptwrite nicht, stale `.tasks.json.*.tmp` werden bereinigt und ignoriert.

Tests:

- 21 neue/angepasste Regressionstests decken die 19 Findings ab.
- Keine Finding-Abweichung oder Gegenposition. Alle Findings wurden umgesetzt.

## Slice 5

Dateien:

- `server.js`
- `brain/scan-brain.js`
- `tests/unit/brain-scan-integration.mjs`

Umgesetzt:

- `migrateToV5()` läuft beim Serverstart idempotent nach v4.
- `AGENT_ZERO_SCAN_ENGINE=agency` schaltet `runScanJob` auf den neuen Brain-Pfad; Default bleibt `legacy`.
- `runBrainScanOnce(job)` rendert State nach `brain-work`, baut Bootstrap-Prompt mit State-File-Referenz, startet den Runner, parst Marker, wendet den Applier an und schreibt `tasks.json` genau einmal atomar.
- Agency-SSE-Phasen: `brain_prepare`, `brain_run`, `brain_apply`; Tool-Fortschritt wird als `job.item_progress` emittiert.
- Fehlerpfade: invalid/no-marker Output wirft ohne Write und setzt history-freies Job-Result; fehlendes `SCAN_DONE` wird partial mit Review-Hinweis; salvaged Timeout wird partial angewandt.
- Job-Result enthält Outcome, Projekt-/Single-Zähler, WorkIQ-Calls, Premium Requests, dropped Marker und Salvage/SCAN_DONE-Flags.

Tests:

- Serie B-1 bis B-5 hermetisch mit Fake-Brain.
- Zusätzlich Timeout-Salvage-Test.

## Slice 6

Dateien:

- `Start-WorkIQ-Scan.ps1`
- `server.js`
- `index.html`
- `brain/scan-brain.js`
- `tests/unit/scan-job-input.mjs`

Umgesetzt:

- Scheduler startet einen einzigen `POST /api/jobs {kind:"scan", input:{scanDays}}` und pollt `/api/jobs/:jobId` bis terminal.
- Scheduler-Lifecycle-Logik vor dem Scan blieb erhalten.
- `scanDays` und tolerant `days` werden für Job-Input und Legacy-`/api/scan` normalisiert.
- UI kennt Agency-Scan-Phasen und zeigt Completed-Zähler aus dem Job-Result.

Tests:

- `scan job input accepts scanDays and legacy days then stores scanDays`
- `server and scheduler use scan job input roundtrip instead of old phase calls`
- Voller `npm test` grün.

## Slice 7

Dateien:

- `index.html`

Umgesetzt:

- Projektkarten zeigen Projekt-Badge, offene/blockierte Line Items, Needs-Review und roten `Du musst aktiv werden`-Indikator bei `pmStatus.userActions`.
- Detailpanel rendert oberhalb der History sechs PM-Sektionen, Evidenzlinks, Confidence-Badges und einklappbare Line Items mit Status, Owner, Due und letztem Evidenzlink.
- Archivierte/superseded Tasks sind default ausgeblendet; Toggle `Archivierte` zeigt sie an.
- Superseded-Hinweis mit Sprung zum Projekt-Task.
- Suche indexiert zusätzlich Line-Item-Titel/currentState und pmStatus-Texte.
- Defensive Rendering-Pfade für Single-Tasks und Alt-Daten ohne `pmStatus`, `lineItems`, `sourceRefs`.

Tests:

- Bestehende Unit-Suite bleibt grün.
- Playwright-Smoke nicht ausgeführt; stattdessen manuelle Checkliste für Master-Browserprüfung:
  - Projektkarte: Badge, offene/blockierte Line Items, roter Nutzeraktionsindikator sichtbar.
  - Detail: sechs PM-Sektionen vor History sichtbar; Line Items einklappbar; Evidenzlinks anklickbar.
  - Archivierte Tasks default verborgen; Toggle zeigt sie; supersededBy-Link springt zum Projekt.
  - Suche findet Line-Item- und pmStatus-Text.
  - Single-Task ohne v5-Felder rendert unverändert.

## Abweichungen

- Keine Slice-8+-Funktion wurde vorgezogen.
- Kein Engine-Default-Flip: `legacy` bleibt Default gemäß A5.
- Kein echter Agency/WorkIQ-Live-Run in diesem Batch; alle Brain-Scan-Tests nutzen Fake-Brain-Injection.

## Offen

- Browser-Verifikation der Slice-7-UI durch den Master.
- Slice 8: auditierte Bestandskonsolidierung mit Dry-Run-Preview.
- Slice 9/10: spätere Legacy-SDK-Entfernung und Live-Verifikation.
