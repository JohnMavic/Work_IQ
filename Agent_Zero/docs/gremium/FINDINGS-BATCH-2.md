VERDICT: CLEAN

# Verifikation Batch 2 (Unabhängiger Verifizierer, 2026-07-05)

**Rolle:** Unabhängiger Auditor im Gremium (NICHT der Erbauer).
**Repo:** E:\Work_IQ\Agent_Zero, Branch `feature/agency-brain`.
**Geprüfte Commits (seit 5d5dde0):** `4c11b08` slice-fix F1-F19, `0b4947e` slice-5,
`a4ffa80` slice-6, `8a9fff7` slice-7 (+ `010f33e` docs). Anmerkung zum Master-Hinweis:
Ein separater slice-fix-Commit `4c11b08` EXISTIERT doch (direkt nach 5d5dde0). Für dieses
Urteil irrelevant — geprüft wurde der **aktuelle Code-Zustand** von HEAD, unabhängig davon,
in welchem Commit ein Fix landete.

**Kurzfassung:** Alle 19 Findings aus FINDINGS-BATCH-1.md sind im Code behoben, jedes mit
einem sinnvollen Regressionstest, der das dokumentierte Szenario abdeckt. Slices 5–7
erfüllen ihre Spezifikation. `npm test` = 59/59 grün. Server-Smoke (neuer Code, isolierte
Kopie, Flag `legacy`) bootet sauber, liefert `/api/health`, spawnt keinen Agency-Prozess,
migriert die (kopierte) v4-tasks.json korrekt nach v5 und beendet sauber; die ECHTE
tasks.json blieb byte-identisch (v4). Prompt ↔ Parser ↔ Applier ↔ Renderer sind
Ende-zu-Ende konsistent. **Keine echten Defekte gefunden.** Es bleiben nur drei
nicht-blockierende Beobachtungen (unten, ausdrücklich KEINE Findings).

Constraints eingehalten: keine echten Agency-Runs; tasks.json nie mutiert (Byte-Hash
vor/nach identisch: `2B961BA4…`); Repo unverändert (keine Commits, keine Code-Edits;
`git status` für Agent_Zero leer; nur diese Datei neu angelegt).

---

## 1. Fix-First — Nachweis pro Finding (alle behoben)

Methodik je Finding: (a) Code-Stichprobe an der genannten Stelle, (b) Existenz + Sinn des
Regressionstests, (c) für die kritischen/security-relevanten zusätzlich eigene adversariale
Reproduktion gegen den echten Applier/Parser/Renderer.

| # | Sev | Fix im Code (verifiziert) | Regressionstest | Eigene Repro |
|---|-----|---------------------------|-----------------|--------------|
| F1 | crit | `assistantTextFromEvent` hat `event.data.content` als 1. Kandidat; `assistant.message_delta`-Akkumulation + `turn_end`-Promotion (brain-runner.js:58-120,335-346) | „reads real assistant.message data.content events" + „promotes delta-only assistant turn at turn_end" | via Unit-Test |
| F2 | crit | `TASK_UPDATE_PATCH_FIELDS`-Whitelist; `validatePatchWhitelist` DROPPT ganzen Marker bei verbotenem Feld; `applyTaskUpdate` iteriert nur Whitelist (applier.js:23-30,153-159,280,549-553) | „TASK_UPDATE patch whitelist blocks destructive task fields" | **JA** — patch mit history/id/archived/… → dropped=1, applied=0, old-1 unverändert (history 1, archived false) |
| F3 | maj | `appendAssistantText` hängt Newline pro Message an (brain-runner.js:285-289) | „separates assistant messages with newlines so markers remain parseable" | via Unit-Test |
| F4 | maj | `runBrain` default `cleanBrainWorkDir=false` → `ensureBrainWorkDir` (kein Wipe); Renderer besitzt den Wipe via `prepareBrainWorkDir` (runner.js:245-253; render.js:221) | „does not clear state files rendered before the run" | via Integrations-Flow (scan-brain rendert→runBrain) |
| F5 | maj | Evidenz-Index wird pro Marker aus `sourceRefIndex`-Kopie validiert; Payload-Refs wandern erst NACH bestandener Validierung in den geteilten Index (applier.js:634,656-657,672-674) | „invalid markers cannot seed evidence for later status updates" | **JA** — dropped PROJECT_NEW (ghost) + TASK_UPDATE(ref=ghost) → beide dropped, Status bleibt `new` |
| F6 | maj | `LINEITEM_UPDATE_PATCH_FIELDS`-Whitelist; `applyLineItemUpdate` iteriert Whitelist, mergt evidenceRefIds additiv (applier.js:31-45,262,499-509) | „LINEITEM_UPDATE patch whitelist protects line item identity and evidence links" | **JA** — patch mit id/evidenceRefIds/… → dropped, li-keep-Id + Evidenz intakt |
| F7 | maj | Fence-Erkennung matcht ` ``` ` UND `~~~` (parser.js:23-28) | „parser ignores markers inside tilde fenced code blocks" | **JA** — `~~~`-umschlossener Marker → 0 Marker |
| F8 | maj | `shortenLink` (≤72 Zeichen) für sourceRefs/legacyLink/Single-Links (render.js:21-31,64,73,80,193) | „shortens long links so a 76-task long-link fixture stays in budget" | **JA — mit ECHTER tasks.json (76 Tasks, v4):** 23.808 B ≤ 24.576 B (vorher 30.332 B), maxLinkLen=72, State wird als **Datei-Referenz** (nicht inline) übergeben → 32-KB-`-p`-Limit unkritisch |
| F9 | maj | Prompt dokumentiert TASK_UPDATE-`sourceRef(s)`-Kanal; Applier persistiert via `collectPayloadSourceRefs`+`mergeSourceRefs`; Renderer zeigt src-IDs auch für Singles (skill.md:44-45,75; applier.js:554-559; render.js:68-81 auch bei Single 195) | „TASK_UPDATE can introduce and persist sourceRefs for its evidence gate" | **JA** — TASK_UPDATE(sourceRefs+evidenceRefIds) → applied, status=done, src persistiert |
| F10 | maj | Prompt: „server replaces the whole pmStatus object; missing entries are removed" (skill.md:85-86); Renderer gibt pmStatus VOLL aus (inline JSON oder Spill-Datei), nie mehr slice(0,3) (render.js:89-105) | „spills full pmStatus instead of truncating replacement data" | via Unit-Test |
| F11 | min | `isWorkIqStartEvent` prüft nur Identitätsfelder (toolName/serverName/…) statt ganzem Event (runner.js:130-145) | „counts WorkIQ only from explicit tool identity fields" | via Unit-Test |
| F12 | min | `silentFailure = !timedOut && typeof exitCode==='number' && exitCode!==0 && …` (runner.js:199) | „does not classify empty timeout as silent failure" | via Unit-Test |
| F13 | min | CLI-Auflösung VOR Datei-Schreiben; Spawn in try/catch mit `cleanupContextFile()` (runner.js:291-321) | „cleans no bootstrap residue when cli resolution fails before spawn" | via Unit-Test |
| F14 | min | `StringDecoder('utf8')` für stdout-Stream + `.end()`-Tail (runner.js:277,362-363,371-373) | „decodes utf8 split across stdout chunks without mojibake" | via Unit-Test |
| F15 | min | `renderHistorySpill` `if (!writeFiles) return null`; `renderScanState` überspringt mkdir/prepare bei writeFiles:false (render.js:114,221-222) | „writeFiles:false does not write history spill files" | via Unit-Test |
| F16 | min | `renderHiddenLineItems` spillt verdeckte Items (mit IDs) bzw. listet IDs inline (render.js:122-137,185) | „spills omitted line item ids so hidden items can be updated" | via Unit-Test |
| F17 | min | `renameWithRetry` (win32 EPERM/EBUSY/EACCES, 3 Retries mit Backoff) (tasks-v5.js:100-119,147-152) | „writeJsonFileAtomic retries transient Windows rename failures" | via Unit-Test |
| F18 | min | Abschließendes `copyFileSync` in try/catch + Warn, Write läuft weiter (tasks-v5.js:93-98) | „writeJsonFileAtomic continues when backup copy is locked" | via Unit-Test |
| F19 | min | `.gitignore`: `.tasks.json.*.tmp` (git check-ignore exit 0) + Startup-Sweep `cleanupStaleAtomicTempsForFile` (server.js:4656) + Write-Time-Sweep (tasks-v5.js:48-77,131) | „cleanupStaleAtomicTempsForFile removes ignored atomic temp files" | git check-ignore verifiziert |

Zusätzlich A3 (Evidenz-Gate) verifiziert: Datum-only-Evidenz → `capConfidence` auf ≤medium
UND Rückführung auf existierende/Batch-SourceRef erzwungen (applier.js:161-181; Tests
„date-only evidence caps confidence to medium…" + „…must resolve to an existing or
same-batch SourceRef"). Status-Änderung ganz ohne Evidenz → Drop („missing evidenceRefIds",
eigene Repro bestätigt).

---

## 2. Slice-Verifikation

### Slice 5 — Brain-Scan hinter Flag + Migration (brain/scan-brain.js, server.js)
- **Applier = einzige Mutationsquelle, EIN atomarer Write:** `runBrainScanOnce` rendert →
  runBrain → parse → `applyMarkerBatch` (Klon) → Telemetrie/Review-Hinweis auf das
  Applier-Ergebnis → genau ein `writeJsonFileAtomic` (scan-brain.js:249). Fehlerpfade
  schreiben NULL-mal (throw vor Zeile 249).
- **Fehlerpfade B-1/B-2/B-3:** invalider/marker-loser Output ⇒ kein Write + job.result
  `historyFree` (207-226); kein SCAN_DONE ⇒ `outcome=partial` + Review-Hinweis (235-240);
  Timeout-Salvage ⇒ Marker normal angewandt, partial. Alle durch Serie-B-Tests + Timeout-
  Salvage-Test gedeckt (Fake-Brain-Injection, kein echter Spawn).
- **Flag-Default legacy (A5):** `getScanEngine` = `'agency'` nur bei env==='agency', sonst
  `'legacy'` (scan-brain.js:274); `runScanJob` verzweigt korrekt (server.js:4240).
- **Migration am Boot idempotent:** `migrateToV5()` an Position 4661 (nach v2/v3/v4);
  `migrateTasksFileToV5` legt v4-`.bak` an und schreibt nur bei version<5. Im Smoke real
  beobachtet: „Migrated tasks.json to v5 (76 tasks, additive)" auf der kopierten v4-Datei;
  idempotent laut Unit-Test.

### Slice 6 — Scheduler/Job-Umschaltung + Bug-Fix (Start-WorkIQ-Scan.ps1, server.js, index.html)
- **Ein Job-POST:** PS1 postet EIN `/api/jobs {kind:"scan", input:{scanDays}}` und pollt
  `/api/jobs/:id` bis terminal (PS1:118-152) — keine 4 Einzel-Phasen-Calls mehr.
- **scanDays-Bug gefixt:** `normalizeScanJobInput` (scanDays ?? days → {scanDays}) wird in
  `/api/scan` (server.js:2577) UND im Job-Input (server.js:4586) angewandt; Roundtrip-Test
  grün.
- **Lifecycle intakt:** Health-Check, Staleness-Restart (>24h ODER kein wiqPid), path-
  restringiertes `Stop-AgentZeroSafe`, Start bleiben unverändert (PS1:71-114). Completed-
  Log behandelt beide Ergebnis-Formen (legacy phase1 / agency outcome).
- **UI:** Agency-Phasen `brain_prepare/brain_run/brain_apply` gemappt + Completed-Zähler
  „N project(s) new · M updated" (index.html:4166-4234,4489-4491).

### Slice 7 — UI Projekt-Tasks + PM-Sicht (index.html, additiv)
- **Karte:** Projekt-Badge, offene/blockierte Line-Item-Zähler, roter „Du musst aktiv
  werden"-Indikator bei `pmStatus.userActions`, Needs-review-Badge (2568-2580, wired 2631).
- **Detailpanel:** 6 PM-Sektionen (Stand heute/Geplant/Nutzer-Aktion nötig/Probleme/Risiken/
  Warten auf) je mit text+Datum+Evidenz-Link+Confidence-Badge, OBERHALB der Konversationen/
  History (2503-2519,2731-2733 vor 2744); einklappbare Line Items mit Status/Owner/Due/
  letzter Evidenz (2527-2556); Superseded-Sprunglink (2558-2565).
- **Archiv-Toggle:** default ausgeblendet, `showArchivedTasks` in localStorage, Button mit
  Count (2254-2281).
- **Suche:** indexiert zusätzlich lineItems (Titel+currentState) und pmStatus-Texte
  (`pmSearchText`, wired 3499).
- **Defensiv für Alt-Daten:** `task.pmStatus || {}`, `asArray(...)`, `pmEntryFromValue`
  (String|Objekt|null), Optional-Chaining — Single-Tasks/v4-Daten ohne pmStatus/lineItems
  rendern crashfrei; Projekt-Renderer geben für Nicht-Projekte `''` zurück.

---

## 3. Tests, Smoke, Konsistenz

- **`npm test`: 59 passed / 0 failed** (selbst ausgeführt). Jedes der 19 Findings hat einen
  benannten, das Szenario abdeckenden Regressionstest (siehe Tabelle §1).
- **Server-Smoke (isolierte Kopie, Flag `legacy`/Default):** Da eine echte Instanz auf
  :3000 läuft und der Single-Instance-Guard 3000–3020 scannt (kein Env-Bypass), UND da der
  Boot tasks.json v4→v5 mutiert, wurde in einer isolierten Kopie mit eigener v4-tasks.json
  gebootet (Guard + WorkIQ-Spawn im Kopie-server neutralisiert — orthogonal zu Boot/
  Migration/Routing). Ergebnis: sauberer Boot, `Agent Zero running`, `/api/health` liefert
  Vertrag inkl. `repoPath`+`wiqPid`, KEIN Agency-/Copilot-Child (nur conhost), kopierte
  tasks.json korrekt nach v5 migriert (+.bak). **ECHTE tasks.json unverändert (v4,
  SHA-256 identisch); laufende :3000-Instanz unberührt.** (Hinweis: Force-Kill lässt das
  Lock der Temp-Kopie liegen — Windows-typisch; App entfernt es bei graceful SIGINT und hat
  Stale-Lock-Recovery. Kein App-Defekt.)
- **Konsistenz Prompt↔Parser↔Applier↔Renderer:** 8 Marker-Namen identisch in
  `MARKER_TYPES` (parser), Skill-Grammatik und `validateMarker`-Cases. Feldnamen/IDs
  geprüft: PROJECT_NEW/UPDATE (title/pmStatus/sourceRefs/supersedesTaskIds/evidenceRefIds),
  LINEITEM_NEW/UPDATE (lineItem/lineItemId/patch mit Whitelist deckt Beispiel-Felder),
  TASK_NEW (sourceRef), TASK_UPDATE (patch-Whitelist + sourceRefs-Kanal), NEEDS_REVIEW
  (kind∈{assignment,status,other}/ref/question/confidence:low), SCAN_DONE (outcome +
  Zähler, in scan-brain gelesen). Renderer zeigt genau die IDs/Refs, die die Grammatik zum
  Referenzieren erwartet (src-IDs auch für Singles; volle pmStatus; verdeckte Line-Item-IDs).

---

## 4. Nicht-blockierende Beobachtungen (KEINE Findings — kein Handlungsbedarf für Batch-2-Abnahme)

Diese drei Punkte sind KEINE Defekte (kein mission-brechendes Szenario innerhalb des
Batch-2-Scopes) und ändern das Urteil CLEAN nicht. Sie sind reine Transparenz-Notizen.

1. **F8-Restverhalten am Ist-Bestand:** Der dokumentierte F8-Defekt (Links nie gekürzt →
   Budget gesprengt, 30.332 > 24.576) ist behoben — real gemessen 23.808 ≤ 24.576. Der
   76-Single-Task-v4-Bestand landet dabei auf der aggressivsten Stufe (summaryChars=0), d.h.
   der Brain sähe für diese Singles keine Summaries. Das ist (a) UNTER Budget = Vertrag
   erfüllt, (b) beabsichtigte graceful Degradation, (c) ein pre-Slice-8-Übergangszustand,
   der wegen A5 (Engine bleibt legacy bis Slice 10) im Agency-Pfad ohnehin erst nach der
   Bestandskonsolidierung auftritt. Kein Downstream-Fehler (`truncated` ist rein
   informativ). Optionale spätere Härtung: Summary-Spill analog zu History/pmStatus.

2. **Kein ID-Eindeutigkeits-Check bei PROJECT_NEW/TASK_NEW:** `applyProjectNew` nutzt
   `payload.taskId || idFactory(...)`; ein (in der dokumentierten Grammatik NICHT
   exponiertes) `taskId`, das mit einer bestehenden ID kollidiert, würde eine zweite Task
   gleicher ID anlegen. Die Skill-Grammatik gibt für PROJECT_NEW/TASK_NEW kein taskId-Feld
   an und weist an, Bestehendes via *_UPDATE zu aktualisieren → kein realistischer Trigger.
   Latente Härtung (Uniqueness-Guard) möglich, aber nicht batch-2-relevant.

3. **pmStatus-Pro-Eintrag-`evidence` nicht einzeln gegen sourceRefs validiert:** Die
   Mutations-Autorisierung erfolgt marker-weit über `evidenceRefIds` (Gate greift). Der
   informative Pro-Eintrag-Pointer `evidence` wird nicht referenziell geprüft; ein
   dangling-Wert rendert lediglich als leerer Evidenz-Link (kein Crash, keine
   Falsch-Autorisierung). Kosmetische Härtung optional.

---

*Ende des Verifizierer-Urteils. Kein Fix durch den Auditor. Repo-Zustand unverändert.*
