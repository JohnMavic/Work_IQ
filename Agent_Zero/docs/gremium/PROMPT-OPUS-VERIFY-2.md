# Auftrag (Claude Opus 4.8 Terminal-Session): Verifikation Batch 2

Rolle: Unabhängiger Verifizierer im Gremium (NICHT der Erbauer). Repo:
E:\Work_IQ\Agent_Zero, Branch feature/agency-brain.

1. Lies: docs/gremium/DECISION.md, RESULT-RATIFICATION.md (A1–A6),
   PROMPT-CODEX-IMPL-2.md (Auftrag inkl. Fix-First F1–F19),
   FINDINGS-BATCH-1.md, RESULT-CODEX-IMPL-2.md (Codex-Bericht),
   TEST-SCENARIOS.md (Serie B), docs/2026-06-11-COPILOT-CLI-AS-BRAIN-GUIDE.md.
2. Prüfe adversarial die Batch-2-Commits (git log/diff seit 5d5dde0):
   a) Sind ALLE 19 Findings wirklich behoben (Stichprobe im Code + Regressionstests
      vorhanden und sinnvoll — F1 echte Event-Form + Delta-Promotion, F2/F6 Whitelists,
      F3 Newline-Join, F4 Cleanup-Zuständigkeit, F5 Evidenz-Index, F7 Tilde-Fences,
      F8 Link-Kürzung/Budget mit ECHTER tasks.json, F9/F10 Prompt↔Applier-Sync)?
   b) Slice 5: runBrainScanOnce — Applier einzige Mutationsquelle, ein atomarer Write,
      Fehlerpfade B-1/B-2/B-3, Flag-Default legacy (A5!), Migration am Boot idempotent.
   c) Slice 6: PS1 → ein Job-POST, scanDays-Bug wirklich gefixt, Lifecycle-Logik intakt.
   d) Slice 7: UI defensiv (pmStatus null, Alt-Tasks), 6 PM-Sektionen, archived-Toggle.
   e) `npm test` selbst ausführen; zusätzlich Server-Smoke: `node server.js` starten
      (freier Port via PORT-env falls nötig), /api/health prüfen, mit Flag legacy
      EXAKT Alt-Verhalten (kein agency-Spawn), sauber beenden.
   f) Konsistenz Prompt (docs/AGENCY_BRAIN_SCAN_SKILL.md) ↔ Parser/Applier ↔ Renderer
      erneut Ende-zu-Ende (Feldnamen, IDs, Marker-Namen, Beispiel-Payloads).
3. Schreibe docs/gremium/FINDINGS-BATCH-2.md:
   Zeile 1: `VERDICT: CLEAN` oder `VERDICT: FINDINGS <n> (critical <c>)`.
   Danach Findings im Format von FINDINGS-BATCH-1.md (nur ECHTE Defekte mit
   konkretem Szenario; Slice-8+-Scope ist kein Defekt). Kein Fix durch dich.
Constraints: KEINE echten agency-Runs starten; tasks.json nie mutieren (Kopien);
Repo-Zustand unverändert hinterlassen (keine Commits, keine Edits).
