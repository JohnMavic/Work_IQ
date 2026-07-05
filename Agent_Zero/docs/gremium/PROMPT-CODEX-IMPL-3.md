# Auftrag an Codex: Batch 3 — Slice 8 (Bestandskonsolidierung) bauen + Dry-Run

Specs: DECISION.md (bes. D8), RESULT-RATIFICATION.md (A2, A5, A6), RESULT-CODEX-PLAN.md
§6-Slice-8 + §7, TEST-SCENARIOS.md (B-6, C-1). Voraussetzung: Batch 2 verifiziert.

## Bauen
- `scripts/migrate-projects-once.mjs` (manuell startbar, kein Server-Autorun):
  Modi `--dry-run` (Default) und `--apply`.
- Dry-Run: rendert ALLE aktiven v5-Tasks (auch nicht-enriched) über den State-Renderer
  in eine Migrations-Variante des State-Docs, fährt EINEN Brain-Run (brain-runner,
  Migrations-Prompt-Variante: Auftrag «konsolidiere Bestand zu Projekten», gleiche
  Marker-Grammatik, D6-Granularität, Evidenz aus vorhandenen Task-Links/sourceRefs;
  WorkIQ-Nutzung erlaubt zur Klärung, Hard-Kill-Budget für DIESEN Lauf 60 statt 25 (A6),
  premiumRequests separat loggen) → validierte Marker werden NICHT angewandt, sondern
  als `docs/gremium/migration-preview.json` geschrieben: {markers[], droppedMarkers[],
  simulatedResult: {projectTasks: [{title, lineItems[].title/status, sourceTaskIds,
  userActions}], archivedTaskIds[], unassignedTaskIds[]}, invariants: {historySumBefore/
  After, linkSumBefore/After}}.
- Σ-Invarianten-Check (B-6) als Code im Apply-Pfad: Apply BRICHT AB, wenn Σ History
  oder Σ Links sinken würde. Backup tasks.json vor Apply (bestehende Mechanik).
- Apply-Modus in diesem Batch NUR implementieren + testen (Fixture), NICHT ausführen.
- Tests: Dry-Run mutiert nichts (tasks.json-Hash identisch); Preview-Format valide;
  Apply auf Fixture erfüllt B-6 + archiviert statt löscht; Abbruch bei
  Invarianten-Verletzung.

## Ausführen (nach grünen Tests)
- Führe den ECHTEN Dry-Run einmal aus (AGENT_ZERO_SCAN_ENGINE bleibt legacy — das
  Skript nutzt den Runner direkt, unabhängig vom Flag). Prüfe grob: Preview enthält
  ≥1 Projekt-Task-Vorschlag mit mehreren Line Items; unassignedTaskIds plausibel.
  Bei Runner-/Marker-Fehlern: analysieren, fixen, wiederholen (max 3 Versuche,
  Fehlerbilder dokumentieren).
- Ein Commit `slice-8: one-time consolidation tool + dry-run`; Preview-JSON committen.
- Bericht `docs/gremium/RESULT-CODEX-IMPL-3.md`: Zeile 1 `DRYRUN: OK <projekte>/<lineitems>/<unassigned>`
  oder `DRYRUN: FAILED <grund>`; danach Details (Laufzeit, workiqCalls, premiumRequests,
  dropped markers, Auffälligkeiten). KEIN Apply, KEIN Slice 9.
