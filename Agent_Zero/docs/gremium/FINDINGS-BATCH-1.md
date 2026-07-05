# Bestätigte Findings der Batch-1-Review (19, adversarial verifiziert)

Quelle: 4-Dimensionen-Review + Refute-Pass (2 von 21 widerlegt). Sortiert nach Schwere.

## F1 [CRITICAL] brain/brain-runner.js:60 (runner)
**Defekt:** assistantTextFromEvent kennt die echte CLI-Event-Form nicht: event.data.content fehlt in der Kandidatenliste — jeder reale Agency-Run liefert leeren assistantText und wird trotz exit 0 als Failure klassifiziert.

**Szenario:** Die reale NDJSON-Event-Form ist {type:'assistant.message', data:{content}} (Guide §7: ev.data?.content; Produktions-Referenz E:\Task_Zero 03\brain.js:952 sowie deren Tests cli-settle.test.js). Die Kandidaten decken nur event.text/content/delta.content/message.* ab. Empirisch verifiziert: runBrain mit Event {type:'assistant.message', data:{content:'...[SCAN_DONE] {...}'}} + exit 0 ergibt ok=false, assistantText="". Folge in Slice 5: jeder echte Scan schlägt fehl, kein Marker wird je angewandt. Die Unit-Tests testen nur die selbst erfundenen Formen (event.content/message.content) und fangen das nicht. Zusatz: auch der Produktions-Fallback für Delta-only-Turns (assistant.message_delta + turn_end-Promotion, brain.js:956-980, dort mit WARN-Log weil real beobachtet) fehlt komplett — ein Turn ohne finales assistant.message ergibt ebenfalls leeren Text.

## F2 [CRITICAL] brain/marker-applier.js:495 (markers)
**Defekt:** applyTaskUpdate blindly Object.assigns the raw patch onto the task with no field whitelist, so a TASK_UPDATE can delete history/sourceRefs/lineItems and overwrite id/archived/supersededBy/taskType — the exact non-destruction invariant D1/R7 promises to enforce — and none of these keys trigger the evidence gate.

**Szenario:** Brain emits [TASK_UPDATE] {"taskId":"old-1","patch":{"history":[],"sourceRefs":[],"lineItems":[],"archived":true,"supersededBy":"ghost","id":"renamed","taskType":"project"}}. Verified with node: applied=1, dropped=0; task history 1->0, sourceRefs 1->0, lineItems 1->0, id becomes 'renamed', archived flips true, and the task is no longer findable by its original id. patchNeedsEvidence() only inspects STATUS_PATCH_FIELDS, so none of these destructive keys require any evidence. History/sourceRefs are silently destroyed and referential integrity (supersededBy pointers to old-1) is broken.

## F3 [MAJOR] brain/brain-runner.js:243 (runner)
**Defekt:** assistant.message-Chunks werden ohne Newline-Separator konkateniert (assistantText += chunk); ein Marker am Anfang der Folge-Message klebt an der letzten Zeile der Vorgänger-Message und wird vom zeilenanker-strikten Parser fail-closed verworfen.

**Szenario:** Run mit zwei assistant.message-Events: 'Consolidation complete.' und '[SCAN_DONE] {"ok":true}'. Ergebnis (verifiziert): assistantText='Consolidation complete.[SCAN_DONE] {"ok":true}' — parseMarkers findet 0 Marker (MARKER_REGEX ist ^-verankert, marker-parser.js:13; v1 bewusst ohne Coercion). Stiller Marker-Verlust: SCAN_DONE fehlt, oder schlimmer, ein mittendrin geklebter PROJECT_NEW fällt aus der Batch → Teil-Anwendung verletzt das Batch-als-atomarer-Intent-Prinzip (Guide §5.4). Guide §7 (text += content + '\n') und Produktions-Referenz (brain.js:953 output.push(data.content + '\n')) hängen beide pro Message ein Newline an.

## F4 [MAJOR] brain/brain-runner.js:193 (prompt-renderer)
**Defekt:** runBrain() leert brain-work unconditionally per prepareBrainWorkDir und loescht damit das gerade vom Renderer geschriebene State-Doc samt aller Spill-Dateien — der A4-Spill-Mechanismus ist mit den gelieferten Modul-APIs nicht benutzbar.

**Szenario:** Reproduziert mit Kopie der echten tasks.json: renderScanState(writeFiles:true) schreibt scan-state-run.md + 52 History-Spill-Dateien (76 Tasks, Histories bis 79 KB > 1,6-KB-Schwelle) nach brain-work; unmittelbar folgender runBrain()-Aufruf ruft als erstes prepareBrainWorkDir() → Verzeichnis leer (0 Dateien), State-Doc und alle Spills geloescht. Es gibt keinen runBrain-Parameter, das Wipe zu ueberspringen. Jede natuerliche Slice-5-Verdrahtung (rendern → runBrain) liefert dem Brain ein State-Doc, dessen 52 referenzierte Spill-Dateien nicht existieren (Read → ENOENT) bzw. loescht das State-File selbst, falls es per Datei statt Prompt-Text uebergeben wird. Renderer und Runner erfuellen A4 je einzeln, zerstoeren sich aber gegenseitig.

## F5 [MAJOR] brain/marker-applier.js:569 (markers)
**Defekt:** addBatchSourceRefs seeds the evidence index from ALL parsed markers before validation, so a sourceRef carried by a marker that later FAILS validation still satisfies the evidence gate for a status change — evidence that is never persisted unlocks a status mutation (fail-open).

**Szenario:** Batch = [PROJECT_NEW] {"sourceRefs":[{"id":"src-ghost","link":"https://x/g","date":"2026-07-05"}],"lineItems":[]} (dropped: 'PROJECT_NEW requires title') followed by [TASK_UPDATE] {"taskId":"old-1","patch":{"status":"done"},"evidenceRefIds":["src-ghost"]}. Verified with node: the PROJECT_NEW is dropped, yet the TASK_UPDATE is APPLIED (applied=1) and old-1 goes from status 'new' to 'done'. src-ghost is persisted nowhere in the resulting store, so the status change rests on evidence the store does not contain, and the bypass is not audit-logged (only the dropped PROJECT_NEW is).

## F6 [MAJOR] brain/marker-applier.js:449 (markers)
**Defekt:** applyLineItemUpdate Object.assigns the raw patch onto the line item with no field whitelist, so a LINEITEM_UPDATE can rename the line-item id and wipe its evidenceRefIds/sourceTaskIds with no evidence gate (none of those keys are STATUS_PATCH_FIELDS).

**Szenario:** [LINEITEM_UPDATE] {"taskId":"old-1","lineItemId":"li-keep","patch":{"id":"li-hijacked","evidenceRefIds":[],"sourceTaskIds":[]}}. Verified with node: applied=1, dropped=0; the line item's id becomes 'li-hijacked' and its evidence/source linkage is silently erased. Renaming the id also breaks any later LINEITEM_UPDATE/NEEDS_REVIEW that references the original li-keep id, and the evidence trail for the line item is destroyed without an audit entry.

## F7 [MAJOR] brain/marker-parser.js:23 (markers)
**Defekt:** Fence detection only recognizes backtick (```) fences; tilde (~~~) fenced blocks are treated as ordinary text, so any marker inside a ~~~ block is parsed and applied — defeating the 'do not apply fenced/example markers' protection (fail-open).

**Szenario:** Model output (or an email body the brain quotes verbatim) contains: line '~~~', then [TASK_NEW]/[TASK_UPDATE] marker, then '~~~'. Verified with node: parseMarkers returns the enclosed marker and applyMarkerBatch applies it (applied=1). An illustrative or prompt-injected marker wrapped in ~~~ is executed as a real state mutation, whereas the identical marker in a ``` block is correctly ignored.

## F8 [MAJOR] brain/render-scan-state.js:137 (prompt-renderer)
**Defekt:** Der Renderer kuerzt Links nie und reisst dadurch mit der echten tasks.json selbst auf der aggressivsten Kuerzungsstufe sein Groessen-Budget (30.332 B > 24.576 B), gibt das Uebermass still zurueck und degradiert das Doc dauerhaft auf Stufe 4 (keine Summaries, kein pmStatus).

**Szenario:** Gemessen mit node -e gegen Kopie der echten tasks.json (76 Tasks): Outlook/Teams-Links sind im Schnitt 219, max. 318 Zeichen und werden roh als 'link=...' emittiert; schon Attempt 4 (summaryChars 0) liegt bei 30.332 Bytes > DEFAULT_STATE_MAX_BYTES 24.576, die Schleife endet und liefert truncated:true ohne weitere Massnahme. Folgen: (a) Budget-Vertrag verletzt — der Unit-Test kaschiert das mit 28-Zeichen-Beispiellinks (maxBytes:14000 gruen); (b) Skill-Doc 5.921 B + State 30.332 B ≈ 36 KB — inline als -p ueber dem 32.767-Limit, nur der 16-KB-File-Context-Pfad des Runners rettet den Spawn; (c) weil die echten Daten bereits heute Attempt 4 erzwingen, sieht der Brain fuer diesen Bestand weder Summaries noch pmStatus.

## F9 [MAJOR] docs/AGENCY_BRAIN_SCAN_SKILL.md:73 (prompt-renderer)
**Defekt:** Die dokumentierte TASK_UPDATE-Grammatik bietet keinen Kanal, um neue SourceRefs einzufuehren, und der State-Renderer rendert fuer Single-Tasks keine SourceRef-IDs — status-aendernde Updates auf Single-Tasks werden dadurch systematisch fail-closed gedroppt.

**Szenario:** Reproduziert mit node -e gegen parser+applier: Brain findet neue E-Mail, dass Single-Task t1 erledigt ist, emittiert grammatikkonform [TASK_UPDATE] {"taskId":"t1","patch":{"status":"done"},"evidenceRefIds":["src-new-mail"]} → Drop mit 'unknown evidenceRefId', Status bleibt 'in-progress'. Der Brain kann die Evidenz nirgends einfuehren: TASK_UPDATE/LINEITEM_UPDATE haben kein sourceRef(s)-Feld, PROJECT_NEW/PROJECT_UPDATE/TASK_NEW betreffen andere Tasks, und existierende Ref-IDs kennt er nicht (Renderer zeigt fuer Singles nur link=, nie src-IDs; alle 76 migrierten v4-Tasks haben ohnehin sourceRefs:[]). Damit ist die Kern-Operation des 2x/Tag-Scans ('Task X ist laut neuer Mail done/in-progress') per dokumentierter Grammatik unmoeglich — jeder Versuch landet im Audit-Log statt im State. (Undokumentierter Ausweg payload.sourceRef wuerde zwar validieren, wird von applyTaskUpdate aber nicht persistiert — Evidenzspur ginge verloren.)

## F10 [MAJOR] docs/AGENCY_BRAIN_SCAN_SKILL.md:69 (prompt-renderer)
**Defekt:** Der Prompt verschweigt, dass PROJECT_UPDATE.pmStatus das gesamte pmStatus-Objekt ERSETZT, waehrend der Renderer pmStatus nur trunkiert zeigt (max. 3 Eintraege/Liste, 120 Zeichen; auf Stufe 3/4 gar nicht) — jede pmStatus-Emission des Brains loescht damit unsichtbare Eintraege.

**Szenario:** Projekt hat pmStatus.problems mit 5 Eintraegen; Renderer zeigt 3 davon auf je 120 Zeichen gekuerzt (renderPmStatus slice(0,3)/truncate 120), auf Budget-Stufen 3-4 (die die echte tasks.json heute bereits erzwingt, s. Budget-Befund) gar nichts. Brain folgt der Grammatik (PROJECT_UPDATE zeigt immer ein volles pmStatus-Objekt), synthetisiert aus dem sichtbaren Ausschnitt und applyProjectUpdate ersetzt per normalizePmStatus das komplette Objekt → Eintraege 4-5 und alle abgeschnittenen Texte sind nach dem Scan weg; ueber mehrere Runs erodieren planned/problems/risks/waitingOn systematisch. Weder warnt der Prompt ('re-emit alle zu erhaltenden Eintraege') noch spillt der Renderer das volle pmStatus wie er es fuer History tut.

## F11 [MINOR] brain/brain-runner.js:92 (runner)
**Defekt:** isWorkIqStartEvent matcht 'workiq' als Substring über das GESAMTE serialisierte Event statt über data.toolName — Nicht-WorkIQ-Toolcalls, deren Argumente 'workiq' enthalten, zählen gegen das Hard-Kill-Budget (D10: 25).

**Szenario:** Verifiziert: drei tool.execution_start-Events des write-Tools mit workiq://-sourceRef-Links im content-Argument (typisch, wenn der Brain Evidenz-Notizen/Spill-Dateien nach brain-work schreibt oder per Shell/grep über das State-Doc mit workiq://-Links arbeitet) wurden alle als workIqCalls gezählt und lösten bei Limit den killTree aus. Realer Effekt: ein gesunder Run (≤10 echte ask-Calls) wird durch Argument-Textmatches vorzeitig hart gekillt — Scan verloren, Premium-Requests verschwendet; besonders kritisch beim ohnehin knappen Slice-8-Migrationslauf (A6). Produktions-Referenz zählt über data.toolName (brain.js:981ff).

## F12 [MINOR] brain/brain-runner.js:142 (runner)
**Defekt:** silentFailure wird auch auf Timeout-/Kill-Pfaden berechnet (exitCode=null gilt als !==0): ein leerer Timeout-Run settlet mit timedOut=true UND silentFailure=true — widersprüchliche Klassifikation gegen die Guide-§6-Signatur.

**Szenario:** Verifiziert: Run hängt ohne Output bis timeoutMs → Ergebnis {timedOut:true, silentFailure:true, exitCode:null}. Die Silent-Failure-Signatur ist laut Guide §6/§7 das Muster eines real beendeten Prozesses (exit!=0 + 0 Bytes; Resume-Korruption/WinGet-Shim), nicht eines vom Orchestrator gekillten Hängers — Guide §6 verlangt ausdrücklich, Umgebungs-/Timeout-Fälle NICHT als Agent-Failure zu klassifizieren. Ein Slice-5+-Konsument, der auf silentFailure die vorgesehene Reaktion (Sonder-Retry) baut, behandelt jeden stillen Timeout doppelt/falsch. Fix: silentFailure an !timedOut && typeof exitCode==='number' && exitCode!==0 koppeln.

## F13 [MINOR] brain/brain-runner.js:198 (runner)
**Defekt:** Kontext-Datei (>16KB-Fallback) wird VOR Binary-Auflösung und Spawn geschrieben; wirft _resolveAgencyCli/buildAgencyArgs/spawn synchron, rejectet runBrain ohne Cleanup — brain-bootstrap-<runId>.md bleibt liegen.

**Szenario:** Verifiziert: prompt >16KB + _resolveAgencyCli wirft ('agency.exe not found', z.B. PATH-Problem nach CLI-Update) → Exception propagiert, cleanupContextFile läuft nie (hängt nur im settle()-Pfad der nie erstellten Promise-Handler), brain-bootstrap-*.md bleibt in brain-work zurück. Abgemildert durch den A4-Wipe des nächsten Runs (prepareBrainWorkDir leert das Verzeichnis), aber die Auftrags-Anforderung 'Cleanup auf JEDEM Settle-Pfad' ist auf den Start-Fehlerpfaden nicht erfüllt; die Datei enthält den vollen Prompt inkl. State-Doc und liegt bis zum nächsten Run auf Platte. Fix: Datei erst nach exe-Auflösung schreiben und Spawn in try/catch mit Cleanup.

## F14 [MINOR] brain/brain-runner.js:260 (runner)
**Defekt:** Per-Chunk Buffer.toString('utf8') ohne StringDecoder: an Chunk-Grenzen zerteilte Multibyte-Zeichen (deutsche Umlaute) werden zu U+FFFD-Mojibake, das JSON-valide bleibt und stillschweigend in Marker-Payloads landet.

**Szenario:** Verifiziert: NDJSON-Zeile mit 'Büro Seestraße', Chunk-Split zwischen den beiden UTF-8-Bytes des 'ü' → assistantText='B��ro Seestraße'. Da U+FFFD ein gültiges JSON-String-Zeichen ist, passiert die korrupte Payload Parser UND Validierung und wird als Titel/Evidenz-Text angewandt — stille Datenkorruption ohne Audit-Spur. Bei deutschsprachigen E-Mail-Inhalten (Kern-Use-Case) und 64-KiB-Pipe-Chunks über viele Runs real erreichbar. Fix: string_decoder (StringDecoder('utf8')) für den stdout-Stream. Hinweis: das Guide-§7-Skeleton teilt den Fehler, der Guide verlangt aber in §6 die Produktions-Härtung obendrauf.

## F15 [MINOR] brain/render-scan-state.js:80 (prompt-renderer)
**Defekt:** renderHistorySpill schreibt Spill-Dateien auch bei writeFiles:false — mit realen Daten crasht renderScanState mit ENOENT (brain-work fehlt) oder schreibt 52 Dateien in ein ungeleertes brain-work.

**Szenario:** Reproduziert mit Kopie der echten tasks.json: renderScanState(data, {writeFiles:false}) wirft ENOENT, wenn brain-work nicht existiert (kein mkdir im writeFiles:false-Pfad, aber fs.writeFileSync fuer jede History > 1,6 KB — bei den echten Daten 52 Stueck); existiert brain-work, werden trotz writeFiles:false 52 Spill-Dateien geschrieben, und zwar OHNE das A4-Cleanup (prepareBrainWorkDir wird uebersprungen), also in ein potenziell stales Verzeichnis. Die Unit-Tests treffen den Pfad nie, weil ihre writeFiles:false-Fixtures leere Histories haben. Der fuer D8 geplante Dry-Run-/Preview-Gebrauch dieses Flags ist damit gegen den Realbestand kaputt.

## F16 [MINOR] brain/render-scan-state.js:122 (prompt-renderer)
**Defekt:** Line Items werden hart auf lineItemLimit gekappt (12 selbst ohne Budget-Druck, 3 auf Stufe 4) und die verdeckten Items erscheinen ohne IDs — der Brain kann sie weder updaten noch als existent erkennen und legt Duplikate an.

**Szenario:** Projekt mit 15 Line Items (nach Slice-8-Konsolidierung von 76 Tasks realistisch): Attempt 1 rendert nur 12, Rest als '3 more line item(s) omitted by budget' ohne IDs/Titel; unter Budget-Druck (den die echten Daten heute schon erzeugen) sinkt das Limit auf 3. Neue Mail betrifft verdecktes Item Nr. 14 → Brain kennt weder dessen li-ID (LINEITEM_UPDATE unmoeglich) noch seine Existenz und emittiert regelkonform LINEITEM_NEW → Duplikat im Projekt. Anders als fuer History gibt es keinen Spill-Mechanismus fuer verdeckte Line Items, obwohl die Slice-4-Spec 'offene Projekte mit Line-Item-Titel+Status+letzter Evidenz' fordert.

## F17 [MINOR] brain/tasks-v5.js:70 (persistence)
**Defekt:** writeJsonFileAtomic hat keinen Retry fuer fs.renameSync-EPERM auf win32 — der neue Schreibpfad schlaegt fehl, wo der alte fs.writeFileSync-Pfad noch erfolgreich schrieb.

**Szenario:** Ein externer Prozess (AV-Scanner, Backup-Tool, Log-Viewer, PowerShell [IO.File]::Open mit Share=ReadWrite ohne Delete) haelt tasks.json waehrend eines Writes offen: renameSync(tmp, tasks.json) wirft EPERM und die Mutation (z.B. Scan-Ergebnis, Status-Aenderung) geht verloren (nur [RECOVERED]-Log, kein Retry). Live verifiziert: bei identisch gehaltenem Handle gelingt das Legacy-fs.writeFileSync, waehrend writeJsonFileAtomic mit 'EPERM rename' scheitert. Node-eigene Prozesse sind unkritisch (libuv oeffnet mit FILE_SHARE_DELETE), aber genau fuer dieses Fremd-Prozess-Fenster nutzen write-file-atomic/graceful-fs auf Windows einen Retry-Loop. Empfehlung: 2-3 Retries mit kurzem Backoff um renameSync.

## F18 [MINOR] brain/tasks-v5.js:49 (persistence)
**Defekt:** rotateBackups: das abschliessende fs.copyFileSync(current -> .1.bak) ist ungeschuetzt — ein gesperrtes Backup-File blockiert JEDEN tasks.json-Write, obwohl die Renames in derselben Funktion try/catch-abgesichert sind.

**Szenario:** Haelt irgendein Prozess tasks.json.1.bak mit Read-Share-only offen (Viewer, Indexer, AV waehrend Scan), wirft copyFileSync EBUSY und writeJsonFileAtomic bricht VOR dem eigentlichen Write ab: solange der Lock besteht, gehen ALLE Task-Mutationen (Scans, Statusaenderungen, Job-History) silently verloren. Live verifiziert: nach Sperren von g.json.1.bak scheitert writeJsonFileAtomic mit 'EBUSY copyfile' und die Hauptdatei behaelt den alten Stand. Asymmetrischer Designfehler: ein Backup-Problem darf den Primaer-Write nicht verhindern (vgl. rotateBackups Zeilen 39-46, wo rm/rename-Fehler bewusst geschluckt werden). Fix: copyFileSync in try/catch + Warn-Log, Write fortsetzen.

## F19 [MINOR] brain/tasks-v5.js:57 (persistence)
**Defekt:** Stale .tasks.json.<pid>.<ts>.<rand>.tmp-Dateien nach hartem Kill werden weder beim naechsten Start aufgeraeumt noch von irgendeiner .gitignore erfasst — sensible Task-Daten (echter Postfach-Inhalt) koennen ins Git gelangen.

**Szenario:** Der eigene Stack killt Node hart (stop-agent-zero.ps1 / Reaper via taskkill /F, Stromausfall): trifft der Kill das Fenster zwischen openSync(tmp,'wx') und renameSync, bleibt eine .tasks.json.*.tmp mit dem KOMPLETTEN tasks.json-Inhalt liegen. Der zufaellige Name (pid+ts+random) macht jeden Rest zur Einweg-Leiche; es gibt keinen Startup-Sweep, also Akkumulation. git check-ignore '.tasks.json.12345.abc.tmp' liefert exit=1 (weder Agent_Zero/.gitignore 'tasks.json' noch E:/Work_IQ/.gitignore 'Agent_Zero/tasks.json.*.bak' matchen den Dot-Prefix-Namen) — ein 'git add .' im Repo-Root stagen die Datei mit echten M365-Inhalten, obwohl tasks.json selbst bewusst ignoriert ist. Fix: Ignore-Pattern '.tasks.json.*.tmp' + Startup-Sweep alter *.tmp im Zielverzeichnis.
