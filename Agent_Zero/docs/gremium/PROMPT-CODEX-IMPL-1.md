# Auftrag an Codex: Implementierung Batch 1 (Slices 1–4)

Du bist der Heavy Lifter im Gremium. Der Plan ist ratifiziert. Implementiere jetzt
Slices 1–4 aus `docs/gremium/RESULT-CODEX-PLAN.md` (§6) — dein eigener Plan — in der
Fassung der Master-Adjudikation `docs/gremium/DECISION.md` (D1–D10). Bei Widerspruch
zwischen Plan und DECISION gilt DECISION.

## Verbindliche Abweichungen von deinem Plan (aus DECISION.md)
- **D1:** `pmStatus`-Einträge sind strukturierte Objekte `{text, date?, evidence?,
  confidence?}` in planned/userActions/problems/risks/waitingOn (nicht string[]).
  `current` bleibt String. Feld `lastSynthesizedAt` bleibt.
- **D3:** Marker-Set: PROJECT_NEW, PROJECT_UPDATE, LINEITEM_NEW, LINEITEM_UPDATE,
  TASK_NEW, TASK_UPDATE, **NEEDS_REVIEW** (statt ASK_USER), SCAN_DONE.
  NEEDS_REVIEW-Payload: `{"kind":"assignment|status|other","ref":"taskId|lineItemId|null",
  "question":"...","confidence":"low"}` → wird NICHT angewandt, sondern in
  `task.brainState.needsReview=true` + `reviewReason` bzw. (ohne ref) in einem
  Root-Array `reviewQueue[]` persistiert. Evidenz-Gate fail-closed: Status-ändernde
  Marker ohne Evidence-Ref (existierend ODER in derselben Batch eingeführt) → Drop +
  Audit-Log-Zeile.
- **D5:** Der Brain-Runner erhält `--add-dir` NUR auf `E:\Work_IQ\Agent_Zero\brain-work`
  (Verzeichnis bei Bedarf anlegen, in .gitignore aufnehmen). cwd = brain-work.
  State-Dokument + File-Context-Bootstrap liegen dort. NIEMALS App-Root whitelisten.
- **D10:** Spawn-Parameter: agency-Engine, argv-Präfix `['copilot','--no-default-mcps',
  '--max-autopilot-continues','0','--model','claude-opus-4.8','--effort','high',
  '--context','long_context']`, Run-Args `['-p',<bootstrap>,'--yolo','--output-format',
  'json','--stream','on','--no-ask-user','--no-auto-update']`, `--add-dir` s.o.,
  `--allow-all-tools`, `--disable-mcp-server playwright`. COPILOT_MODEL-env-Pin +
  Duplikat-Strip von --model/--effort/--context aus Caller-Args. Timeout 25 min,
  Salvage ≥200 B, Single-Settle, killTree (taskkill /T), Silent-Failure-Signatur mit
  agency-stderr-Banner-Herausrechnung (Muster: E:\Task_Zero 03\services\agency-banner.js).

## Slices (jeder Slice: implementieren → Unit-Tests schreiben → `npm test` grün → EIN Commit)
1. **Slice 1 — Brain-Runner-Skeleton:** `brain/agency-cli.js` (Binary-Auflösung via
   `where.exe agency.exe`, memoized; Engine-Args; Modell-Pin) + `brain/brain-runner.js`
   (Spawn-Envelope: NDJSON-Line-Buffering, assistant.message-Aggregation,
   tool.execution_*-Callback mit Zähler, Timeout/Salvage/Single-Settle, strukturierte
   Error-Felder exitCode/durationMs/stdoutBytes/stderrBytes/timedOut/silentFailure,
   File-Context-Pattern >16 KB mit per-Run-unique Name + Cleanup auf jedem Settle-Pfad,
   WorkIQ-Call-Hard-Kill bei 25 tool-calls). Injection-Seam `_spawnFn` für Tests.
   Tests: exit0+Text=success; exit0+leer=failure; Timeout mit ≥200B=salvaged;
   exit≠0+0B stdout+0B residual stderr=silentFailure:true; Banner-Fixture→residual=0.
2. **Slice 2 — Atomic Write + v5-Migration:** `writeTasksAtomic` (tmp+fsync+rename+
   rotierende .bak, max 3) in server.js integrieren (alle tasks.json-Writes darüber);
   `migrateToV5()` additiv (Root `brain{}`, `reviewQueue:[]`; Tasks: schemaVersion 5,
   taskType:'single', archived:false, supersededBy:null, supersedesTaskIds:[],
   lineItems:[], sourceRefs:[], pmStatus:null, brainState-Defaults). Backup
   `tasks.json.v4-<timestamp>.bak` vor Migration. Tests: Fixture-Roundtrip, Idempotenz,
   kein Feldverlust, Task-Anzahl konstant.
3. **Slice 3 — Marker-Parser + Applier:** `brain/marker-parser.js` (fence-aware,
   Single-Line-JSON, MARKER_REGEX aus Set abgeleitet) + `brain/marker-applier.js`
   (Schema- + Referenz-Validierung fail-closed; Batch = atomarer Intent: erst alle
   validieren/auflösen, dann EINE Mutation der geladenen Struktur; PROJECT_NEW erzeugt
   Projekt-Task inkl. sourceRefs/lineItems; supersedesTaskIds → archived:true +
   supersededBy, nie löschen; Evidenz-Gate; Audit-Log als JSONL nach
   `logs/brain-audit.jsonl`). Tests: gültige Batch erzeugt Projekt; unbekannte Referenz
   → Drop; Fence-Marker ignoriert; Statusänderung ohne Evidenz → Drop; superseded
   archiviert nicht gelöscht; NEEDS_REVIEW → reviewQueue/brainState.
4. **Slice 4 — Brain-System-Prompt + State-Renderer:** `docs/AGENCY_BRAIN_SCAN_SKILL.md`
   (Projektmanager-Denke nach deinem Plan §5.8 inkl. D6-Granularitätsregel: Projekt =
   reales Vorhaben wie der Nutzer es denkt, typisch Ort+Zweck; Teilthemen desselben
   Vorhabens = Line Items, NIE separate Projekte; 1 Signal → max 1 Projekt; unsicher →
   NEEDS_REVIEW; Wahrheitshierarchie WorkIQ-Evidenz > State-Doc > alte Summaries;
   Budget: max 10 workiq-Calls; Marker-Grammatik exakt; Self-Check vor Antwort;
   KEINE Seestrasse-Fakten!) + `brain/render-scan-state.js` (kompakte Projektion:
   offene Projekte mit Line-Item-Titel+Status+letzter Evidenz, Single-Tasks mit
   Titel/Status/Link/1-Zeilen-Summary, archivierte nur als ID-Liste, lastScan-Anker,
   Größen-Budget mit kontrollierter Kürzung). Tests: alle offenen Tasks enthalten,
   Größe < Schwelle bei 76-Task-Fixture, keine einkodierten Projektfakten.

## Ratifizierungs-Auflagen (RESULT-RATIFICATION.md — bindend für diesen Batch)
- **A3 (Evidenz-Gate-Härtung, Slice 3):** Liegt bei einem Status-ändernden Marker nur
  ein Datum (kein Link) als Evidenz vor, erzwingt der Applier `confidence` ≤ medium
  und das Datum muss auf eine SourceRef derselben Batch/`sourceRefs`-Bestand
  zurückführbar sein — sonst Drop + Audit. Test dafür schreiben.
- **A4 (brain-work-Hygiene, Slice 1+4):** Der Runner/Renderer legt `brain-work\` pro
  Run an bzw. LEERT es vor dem Run (keine Stale-Dateien aus Vorläufen); `brain-work/`
  in `.gitignore`; der State-Renderer kann zusätzlich Spill-Dateien (Voll-Historie
  einzelner Tasks) nach brain-work schreiben, auf die das State-Doc per Dateiname
  verweist (Read-Tool-Anweisung im Doc).
- **A1-ERGEBNIS (Flag-Kombination): BESTANDEN, 2026-07-05.** Live-Probe mit
  `--no-default-mcps --disable-mcp-server playwright`: workiq blieb `connected`,
  workiq-ask real ausgeführt, exit 0. `--no-default-mcps` ist damit freigegeben.
  Zusätzlich im Runner: `--disable-mcp-server github-mcp-server` (Scan-Brain braucht
  kein GitHub; gleicher Mechanismus, kein Risiko für workiq).

## Arbeitsregeln
- Branch `feature/agency-brain` (bist du drauf). Ein Commit pro Slice, Message-Präfix
  `slice-N:`. Working Tree ist sauber — committe NUR deine eigenen Änderungen.
- `npm test` (node --test tests/unit/*.mjs) muss nach jedem Slice grün sein; bestehender
  Test job-lifecycle.mjs darf nicht brechen.
- Nichts von Slice 5+ vorziehen: KEINE Verdrahtung in runScanJob, KEIN UI-Code,
  KEINE Entfernung von SDK/WorkIQ-Code. Die App muss sich nach Batch 1 exakt wie
  vorher verhalten (nur ungenutzte neue Module + Migration liegt bereit, wird aber
  noch NICHT beim Boot ausgeführt — Migration erst in Slice 5 aktivieren).
- ES Modules (package.json type:module beachten).
- Schreibe am Ende `docs/gremium/RESULT-CODEX-IMPL-1.md`: pro Slice was gebaut/getestet
  wurde (Dateien, Zeilen, Testnamen), was offen ist, Abweichungen + Begründung.
