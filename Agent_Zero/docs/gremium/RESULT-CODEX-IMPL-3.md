DRYRUN: OK 3/18/20

# Codex Impl 3 — Slice 8 Bestandskonsolidierung

## Status
- Slice 8 gebaut: `scripts/migrate-projects-once.mjs` mit `--dry-run` Default und `--apply` aus Preview.
- Tests grün: `npm test` → 63 passed.
- ECHTER Dry-Run ausgeführt, kein Apply.
- Preview geschrieben: `docs/gremium/migration-preview.json`.

## Finaler Dry-Run
- runId: `migration-1783249928256`
- generatedAt: `2026-07-05T11:25:13.342Z`
- Laufzeit: `784948 ms`
- workiqCalls: `0`
- premiumRequests: `0`
- dropped markers: `0`
- parseErrors: `0`
- dryRunMutatedTasks: `false`

## Preview-Kurzcheck
- Projektvorschläge: `3`
- Line Items: `18`
- archivedTaskIds: `56`
- unassignedTaskIds: `20`
- Invarianten: history `739 -> 798`, links `106 -> 221`, tasks `76 -> 79`, deletedTaskIds `[]`.
- Grob plausibel: Seestrasse ist ein Projekt mit 9 Line Items; AV, Cabling, CorpNet, Focus Rooms, PC relocation und SupplierWeb sind Line Items statt getrennte Projekte.
- Unassigned enthält vor allem cross-site/generische/standalone Tasks und nicht eindeutig zuordenbare Items.

## Auffälligkeiten / Wiederholungen
- Erster überlappender Dry-Run schrieb eine Preview mit 0 Projektvorschlägen, weil 3 `PROJECT_NEW` Marker wegen `pmStatus.*` String-Arrays gedroppt wurden. Fix: Migrations-Prompt erzwingt Objekt-Arrays für `pmStatus.planned/userActions/problems/risks/waitingOn`.
- Ein paralleler Run erzeugte bereits 4 Projektvorschläge, hatte aber 1 gedroppten `NEEDS_REVIEW` Marker (`kind:"grouping"`). Fix: Migrations-Prompt erzwingt `assignment|status|other`.
- Finaler Versuch lief isoliert unter `tests/runs/migration-dry-run/brain-work` und erzeugte die committed Preview ohne gedroppte Marker.

## Apply
- Nicht ausgeführt.
- Apply-Pfad ist implementiert und durch Fixtures getestet: validierte Preview-Marker, Backup via bestehender Atomic-Write-Mechanik, hartes Σ-Gate vor Write.
