# Auftrag an Codex: Implementierung Batch 2 (Slices 5–7)

Fortsetzung nach Batch 1 (RESULT-CODEX-IMPL-1.md). Es gelten weiterhin:
`docs/gremium/DECISION.md` (D1–D10) > `docs/gremium/RESULT-CODEX-PLAN.md` (§6) und die
Ratifizierungs-Auflagen A1–A6 (`docs/gremium/RESULT-RATIFICATION.md`). Insbesondere
**A5: Engine-Default bleibt `legacy`** — der Flip auf `agency` passiert erst in Slice 10.

## 0. Fix-First: bestätigte Findings aus der Batch-1-Review
Lies `docs/gremium/FINDINGS-BATCH-1.md` VOLLSTÄNDIG: 19 adversarial verifizierte
Findings (F1–F19; 2 critical, 8 major, 9 minor), jedes mit konkretem Fehlerszenario.
Behebe ALLE 19 zuerst, bevor du Slice 5 beginnst. Für jedes Finding einen
Regressionstest, der das dokumentierte Szenario abdeckt (insb. F1: echte Event-Form
`{type:'assistant.message', data:{content}}` + Delta-only-Turn-Promotion nach
Task-Zero-03-Vorbild; F2/F6: Feld-Whitelists für TASK_UPDATE/LINEITEM_UPDATE-Patches;
F3: Newline-Join pro Message; F4: runBrain darf das vom Renderer geschriebene
State-Doc nicht wegräumen — Zuständigkeit brain-work-Cleanup EINDEUTIG einem Ort
zuordnen; F5: Evidenz-Index nur aus VALIDIERTEN Markern speisen; F9/F10:
Prompt-Grammatik und Applier exakt synchronisieren, inkl. SourceRef-Kanal für
TASK_UPDATE und dokumentierter PROJECT_UPDATE-pmStatus-Replace-Semantik mit
Renderer-Vollausgabe von pmStatus). Ein Commit `slice-fix: batch-1 review findings
F1-F19`. `npm test` grün. Wo du einem Finding widersprichst: NICHT stillschweigend
ignorieren, sondern im RESULT begründen und den Master entscheiden lassen.

## Slice 5 — Brain-Scan hinter Feature-Flag (+ Migration aktivieren)
Dateien: `server.js`, neu `brain/scan-brain.js`, Tests `tests/unit/brain-scan-integration.mjs`.
- Boot: `migrateToV5()` beim Serverstart aktivieren (einmalig, mit v4-Backup; idempotent).
- `AGENT_ZERO_SCAN_ENGINE` env-Flag (`legacy` Default | `agency`).
- `runBrainScanOnce(job)`: brain-work leeren → `renderScanState()` → Bootstrap-Prompt
  (Skill-Datei + State-Doc-Referenz per File-Context-Pattern) → `brain-runner` Run →
  Batch-Parse (`marker-parser`) → `marker-applier` (einzige Mutationsquelle) →
  EIN atomarer Write → Job-Result mit {outcome aus SCAN_DONE|partial, newProjects,
  updatedProjects, newSingleTasks, workiqCalls, premiumRequests (aus result-Event),
  droppedMarkers}. Root-`brain{}`-Telemetrie aktualisieren.
- `runScanJob` verzweigt nach Flag: agency → `runBrainScanOnce`; legacy → bestehende
  4 Phasen unverändert. SSE-Phasen im Agency-Pfad: `brain_prepare`, `brain_run`
  (mit Tool-Event-Fortschritt), `brain_apply`.
- Fehlerpfade: invalider Brain-Output ⇒ tasks.json unverändert + Job failed + History-
  freier Fehlerreport im Job; Timeout-Salvage ⇒ Marker aus Salvage-Text normal anwenden,
  outcome partial; kein SCAN_DONE ⇒ outcome partial + Review-Hinweis (B-3).
- Tests (Serie B aus docs/gremium/TEST-SCENARIOS.md): B-1 Fake-Brain-Output mutiert
  korrekt (ein atomarer Write); B-2 invalider Output ⇒ unverändert + failed; B-3 ohne
  SCAN_DONE ⇒ partial; B-4 Konsolidierungs-Fixture (M Vorhaben, eines mit 2 Workstreams
  am selben Ort ⇒ EIN Projekt mit Line Items, Fremd-Thema separat, kein Signal
  verloren); B-5 Folge-Scan-Fixture (Update statt Duplikat). Fake-Brain via
  Injection-Seam (kein echter agency-Spawn in Tests).

## Slice 6 — Scheduler/Job-Umschaltung + Bug-Fix
Dateien: `Start-WorkIQ-Scan.ps1`, `server.js` (klein), `index.html` (nur Labels).
- `Start-WorkIQ-Scan.ps1`: statt 4 Einzel-Phasen-Aufrufen EIN `POST /api/jobs
  {kind:"scan", input:{scanDays:N}}` + Poll auf Job-Ende (bestehende Job-API). Die
  Server-Lifecycle-Logik (Health-Check, Restart >24h, Lock) bleibt unverändert.
- `days`/`scanDays`-Bug fixen: Server akzeptiert `scanDays` (und tolerant `days`) im
  Job-Input UND in `/api/scan` (Legacy).
- UI: Phase-Labels für Agency-Scan-Job (brain_prepare/brain_run/brain_apply) sauber
  anzeigen; Zähler aus Job-Result (Projekte neu/aktualisiert) im Completed-Event.
- Test: Job-Input-Roundtrip (scanDays landet im Job; Legacy-Scan liest ihn).

## Slice 7 — UI Projekt-Tasks + PM-Sicht
Datei: `index.html` (additiv, kein Framework).
- Task-Karte (`renderTaskCard`): bei `taskType==='project'` Projekt-Badge, Zähler
  offene/blockierte Line Items, roter «Du musst aktiv werden»-Indikator wenn
  pmStatus.userActions nicht leer.
- Detailpanel (`renderTaskDetail`-Äquivalent): oberhalb der History die 6 PM-Sektionen
  (Stand heute / Geplant / **Nutzer-Aktion nötig** / Probleme / Risiken / Warten auf)
  — je Eintrag text + Datum + Evidenz-Link + Confidence-Badge; darunter Line Items
  (Titel, Status-Chip, Owner, Due, letzter Evidenz-Link), einklappbar; NEEDS_REVIEW-
  Badge aus brainState/reviewQueue.
- Archivierte/superseded Tasks: default ausgeblendet; Toggle «Archivierte anzeigen»
  in der Filter-Bar; supersededBy-Hinweis mit Sprung-Link zum Projekt-Task.
- Suche durchsucht zusätzlich lineItems (Titel + currentState) und pmStatus-Texte.
- Kein Bruch für Single-Tasks und Alt-Daten (pmStatus null etc. defensiv rendern).
- Test: bestehende Unit-Suite bleibt grün; für die UI reicht in diesem Slice ein
  DOM-Smoke via Playwright NUR wenn schnell machbar, sonst dokumentierte manuelle
  Checkliste in RESULT (der Master verifiziert die UI anschließend selbst im Browser).

## Arbeitsregeln
Wie Batch 1: ein Commit pro Slice (`slice-N:`), `npm test` grün nach jedem Slice,
nichts aus Slice 8+ vorziehen (KEINE Bestandskonsolidierung, KEINE SDK-Entfernung),
App-Verhalten mit Flag `legacy` (Default) identisch zu heute (bis auf Migration+Bugfix).
Abschlussbericht nach `docs/gremium/RESULT-CODEX-IMPL-2.md` (pro Slice: Dateien,
Tests, Abweichungen, offene Punkte).
