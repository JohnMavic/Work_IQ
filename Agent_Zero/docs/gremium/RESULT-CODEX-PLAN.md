# Codex-Implementierungsplan: Agent Zero -> Agency-Brain

Stand: 2026-07-05  
Basis: `MISSION.md`, `FACTS.md`, Brain-Guide, Codepruefung in `server.js`, `index.html`,
`Start-WorkIQ-Scan.ps1`, `docs/*_SKILL.md`, `tasks.json` und Referenz `E:\Task_Zero 03`.

## 1. Code-verifizierte Ausgangslage

- Agent Zero ist heute eine Express/Single-HTML-App mit `tasks.json` als Store.
- `tasks.json` ist Version 4, enthaelt 76 flache Tasks, davon 24 mit Zurich/See-Bezug im
  Titel. Kein Task hat `projectId` oder `lineItems`.
- `server.js` startet einen eigenen persistenten WorkIQ-MCP-Subprozess aus
  `node_modules/@microsoft/workiq@0.2.8` (`server.js:95-106`) und nutzt fuer fast alle
  LLM-Schritte `@github/copilot-sdk`.
- Der geplante Scan in `Start-WorkIQ-Scan.ps1` ruft die vier alten Phasen einzeln auf.
  Dabei sendet er in Phase 1 `{"days":N}` (`Start-WorkIQ-Scan.ps1:120-123`), der Server
  liest aber `req.body.scanDays` (`server.js:2560`).
- Phase 1 erzeugt aus WorkIQ-Markdown immer `action: 'new'` fuer Email und Teams
  (`server.js:2656-2677`). Die `action:update`-Zweige existieren, werden aber durch diese
  Parser-Pipeline nicht erreicht.
- Phase 2 und Phase 3 laufen pro Task und koennen kein Projektverstaendnis bilden.
- Phase 4 liefert nur Merge-Vorschlaege aus gekuerzten Summaries
  (`server.js:3335-3425`), persistiert sie nicht und wird im geplanten Scan nur geloggt.
- `index.html` rendert eine flache Task-Liste und eine Detailansicht. Die UI kann
  additiv erweitert werden, ohne die SPA neu zu schreiben.
- Die lokale Copilot-MCP-Konfiguration enthaelt bereits WorkIQ als
  `npx -y @microsoft/workiq@1.0.0 --account ... mcp` mit Tool `ask`. Agent Zero selbst
  nutzt diese Konfiguration heute nicht.

## 2. Ziel-Architektur

### Komponenten

1. **Express-Orchestrator bleibt State Owner**
   - `server.js` bleibt Besitzer von `tasks.json`, Jobs, SSE, Task-CRUD, Lockfile,
     Scheduler-Kompatibilitaet und UI-API.
   - Der Brain-Prozess darf nie selbst `tasks.json` schreiben. Er gibt nur Marker aus.

2. **Agency-Brain-Runner**
   - Neues kleines Modul, z.B. `brain/agency-cli.js` und `brain/scan-brain.js`.
   - Spawn ueber `agency copilot` mit absolut aufgeloestem `agency.exe` via `where.exe`.
   - Argumente:
     - `copilot --no-default-mcps --max-autopilot-continues 0`
     - `--model claude-opus-4.8 --effort high --context long_context`
     - `-p <prompt-or-bootstrap> --yolo --output-format json --stream on --no-ask-user`
     - `--add-dir E:\Work_IQ\Agent_Zero --allow-all-tools`
     - `--disable-mcp-server playwright --disable-mcp-server powerbi-remote`
   - WorkIQ kommt ausschliesslich ueber die geerbte `~/.copilot/mcp-config.json`, nicht
     ueber einen von Agent Zero gespawnten WorkIQ-Client.

3. **Layer-2-State-Dokument**
   - Vor jedem Brain-Run rendert der Server ein kompaktes Markdown-Dokument, z.B.
     `.agent-zero-brain\scan-state-<runId>.md`.
   - Inhalt: alle offenen Projekt-Tasks, Line Items, relevante archivierte/superseded
     Tasks, letzte Scan-Anker, Quellenindex, Budget, Marker-Grammatik.
   - Bei >16 KB Prompt wird wie in Task Zero ein per-Run-eindeutiges Kontextfile genutzt,
     damit das Windows-CreateProcess-Limit nicht erreicht wird.

4. **Marker-Parser und v5-Applier**
   - Batch-only: Marker werden nach Abschluss aus dem finalen Assistant-Text gelesen.
   - Keine Live-Anwendung aus dem Stream in v1.
   - Validierung fail-closed, referentiell strikt, anschliessend eine einzige atomare
     `tasks.json`-Mutation.

5. **Scan-Job bleibt UI-Vertrag**
   - `POST /api/jobs {kind:"scan"}` bleibt der Einstieg fuer UI und Scheduler.
   - Intern wird der heutige 4-Phasen-Runner durch einen Brain-Scan-Runner ersetzt.
   - SSE sendet weiter `phase_changed`, `phase_done`, `job.completed`, aber die Phasen
     werden logisch neu benannt: `brain_prepare`, `brain_run`, `brain_apply`, optional
     `brain_verify`.

6. **Frontend bleibt Single-File-SPA**
   - Die flache Task-Liste bleibt. Ein Projekt ist weiterhin ein Task-Card-Eintrag.
   - Detailansicht bekommt PM-Sicht und Line-Item-Liste, falls `task.taskType==="project"`.
   - Alte Tasks ohne `lineItems` werden unveraendert gerendert.

### Datenfluss

1. Scheduler oder UI startet `kind:"scan"`.
2. Server rendert Layer-2-State aus `tasks.json`.
3. Server startet genau einen globalen Agency-Brain-Run.
4. Brain liest State, fragt WorkIQ selbst ueber MCP `workiq.ask`, konsolidiert Projekte und
   gibt Marker aus.
5. Server aggregiert Assistant-Text, parst Marker, validiert alle Referenzen, schreibt
   `tasks.json` atomar und erzeugt History-Eintraege.
6. UI bekommt per SSE Fortschritt und laedt Tasks neu.

## 3. Datenmodell v5

V5 ist additiv. Bestehende Felder bleiben erhalten, damit alte UI- und API-Pfade nicht
sofort brechen.

### Root

```json
{
  "version": 5,
  "lastScan": "ISO-8601|null",
  "brain": {
    "engine": "agency",
    "model": "claude-opus-4.8",
    "lastRunId": "string|null",
    "lastRunAt": "ISO-8601|null",
    "lastOutcome": "success|partial|failed|null",
    "lastPremiumRequests": "number|null",
    "lastWorkIqCalls": "number|null"
  },
  "tasks": []
}
```

### Task-Felder

Bestehende Felder bleiben: `id`, `title`, `summary`, `source`, `from`, `date`, `link`,
`status`, `notes`, `history`, `doneAt`, `enrichmentStatus`, `updateCheckStatus`,
`enrichedAt`, `lastUpdateCheck`, `lastSuccessfulUpdateCheck`, `createdAt`, `updatedAt`,
`additionalLinks`, `ambiguities`, `noMergeWith`, `pendingPlan`, `activeJob`, `jobHistory`.

Neue v5-Felder:

```json
{
  "schemaVersion": 5,
  "taskType": "project|single",
  "projectKey": "stable-normalized-slug|null",
  "projectAliases": ["string"],
  "archived": false,
  "supersededBy": "task-id|null",
  "supersedesTaskIds": ["task-id"],
  "pmStatus": {
    "current": "string",
    "planned": ["string"],
    "userActions": ["string"],
    "problems": ["string"],
    "risks": ["string"],
    "waitingOn": ["string"],
    "confidence": "high|medium|low",
    "lastSynthesizedAt": "ISO-8601"
  },
  "sourceRefs": [],
  "lineItems": [],
  "brainState": {
    "lastScanRunId": "string|null",
    "lastEvidenceAt": "ISO-8601|null",
    "needsReview": false,
    "reviewReason": "string|null"
  }
}
```

### SourceRef

```json
{
  "id": "src-uuid-or-shortid",
  "type": "email|teams|manual",
  "title": "string",
  "from": "string|null",
  "date": "ISO-8601|null",
  "link": "string|null",
  "sourceTaskId": "task-id|null",
  "firstSeenAt": "ISO-8601",
  "lastSeenAt": "ISO-8601",
  "evidenceText": "short factual quote/summary, no long body copy"
}
```

### LineItem

```json
{
  "id": "li-uuid-or-stable-slug",
  "title": "string",
  "category": "workstream|action|decision|dependency|risk|info",
  "status": "open|in-progress|waiting|blocked|done|on-radar",
  "owner": "string|null",
  "userActionRequired": false,
  "userAction": "string|null",
  "currentState": "string",
  "plannedNext": "string|null",
  "dueAt": "ISO-8601|null",
  "waitingOn": "string|null",
  "problem": "string|null",
  "risk": "string|null",
  "confidence": "high|medium|low",
  "evidenceRefIds": ["sourceRef.id"],
  "sourceTaskIds": ["task-id"],
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

### Backward-Kompatibilitaet

- Ein `single` Task ohne `lineItems` funktioniert wie heute.
- Fuer Projekt-Tasks ist `summary` weiterhin der menschenlesbare Kurzueberblick.
- `link` bleibt der wichtigste oder neueste Source-Link, `additionalLinks` wird aus
  `sourceRefs` abgeleitet, damit bestehende UI-Links weiter funktionieren.
- Archivierte/superseded Ursprungstasks bleiben in `tasks.json`, werden aber in der UI
  standardmaessig ausgeblendet.

## 4. Marker-Grammatik fuer Agent Zero

Empfehlung: minimales Set, JSON immer einzeilig auf derselben Zeile.

```text
[PROJECT_NEW] {"projectKey":"...","title":"...","aliases":[],"summary":"...","pmStatus":{...},"sourceRefs":[...],"lineItems":[...],"supersedesTaskIds":[]}
[PROJECT_UPDATE] {"taskId":"...","title":"...","summary":"...","pmStatus":{...},"sourceRefs":[...],"supersedesTaskIds":[]}
[LINEITEM_NEW] {"taskId":"...","lineItem":{...}}
[LINEITEM_UPDATE] {"taskId":"...","lineItemId":"...","patch":{...},"evidenceRefIds":[]}
[TASK_NEW] {"title":"...","summary":"...","sourceRef":{...},"status":"new|on-radar|needs-attention"}
[TASK_UPDATE] {"taskId":"...","patch":{...},"evidenceRefIds":[]}
[SCAN_DONE] {"runId":"...","outcome":"success|partial","newProjects":0,"updatedProjects":0,"newSingleTasks":0,"archivedTasks":0,"workIqCalls":0,"notes":"..."}
[ASK_USER] {"question":"...","options":["..."]}
```

Validierungsregeln:

- Marker nur ausserhalb von Code-Fences.
- Ein Marker pro physischer Zeile, Tag plus valides Single-Line-JSON.
- `taskId`, `lineItemId`, `sourceTaskIds`, `evidenceRefIds` muessen existieren oder in
  derselben Batch durch ein valides `PROJECT_NEW`/`PROJECT_UPDATE` eingefuehrt werden.
- Jede Statusaenderung, jedes neue Problem/Risiko und jede Nutzer-Aktion braucht
  mindestens einen Evidence-Ref mit Datum oder Link.
- `PROJECT_NEW` darf keine Fakten ohne `sourceRefs` aufnehmen.
- `PROJECT_UPDATE` darf bestehende `sourceRefs` nur ergaenzen oder `lastSeenAt`
  aktualisieren, nicht loeschen.
- `supersedesTaskIds` archiviert Ursprungstasks, loescht sie aber nie.
- Wenn `SCAN_DONE` fehlt, ist der Run `partial`: gueltige Marker duerfen angewendet
  werden, aber `brain.lastOutcome` wird `partial` und ein Review-Hinweis wird geloggt.
- Kein deterministisches Coercing in v1. Ungueltige Marker werden geloggt und verworfen.

## 5. Entscheidungen zu den 8 Design-Fragen

### 1. Brain-Topologie

Empfehlung: **ein globaler Scan-Brain-Run pro Scan**.

Begruendung: Die Projekt-Konsolidierung ist genau der Teil, den per-Task- oder
per-Projekt-Runs nicht sehen. Bei 76 Tasks ist ein kompakter Layer-2-State realistisch,
waehrend per-Projekt-Runs erst eine Vorgruppierung brauchen und die Premium-Request-Kosten
multiplizieren. Hybrid-Repair-Runs werden erst eingefuehrt, wenn die globale State-Groesse
oder Marker-Fehlerrate messbar problematisch wird.

### 2. Sessions

Empfehlung: **fresh `-p` pro Scan mit komplettem Layer-2-State-Dokument, keine persistente
`--resume`-Session in v1**.

Begruendung: Disk und WorkIQ sind die Wahrheit. Ein Scan laeuft planmaessig nur wenige Male
pro Tag; die Tokenersparnis einer persistenten Session rechtfertigt jetzt nicht
Session-Store-Wachstum, Resume-Korruption und Drift-Recovery. `--session-id`/`--resume`
wird erst gerechtfertigt, wenn Messdaten zeigen, dass der State dauerhaft zu gross wird
oder die Run-Kosten trotz Kompakt-State nicht tragbar sind.

### 3. Welche Phasen ersetzt der Brain?

Empfehlung: **Der Brain ersetzt die vier heutigen Scan-Phasen vollstaendig**.

- Discovery: Brain sucht neue Signale selbst via WorkIQ.
- Enrichment: Brain liest relevante Threads/Teams-Kontexte im selben Lauf.
- Update Check: Brain vergleicht neue Signale gegen `lastEvidenceAt` und vorhandene
  Line Items.
- Consolidate: Brain erstellt oder aktualisiert Projekt-Tasks direkt statt nur
  Merge-Vorschlaege zu liefern.

Der selbst gespawnte WorkIQ-0.2.8-Client (`server.js:62-477`) bleibt nur waehrend einer
kurzen Fallback-Phase hinter einem Legacy-Flag. Nach Umstellung der noch verbleibenden
SDK-Routen wird er entfernt, ebenso die Dependency `@microsoft/workiq`.

### 4. Datenmodell v5

Empfehlung: **Project-Task als normaler Task mit `taskType:"project"` und `lineItems[]`**.

Begruendung: Das haelt `tasks.json`, Task-CRUD, Statusfilter, SSE und UI-Auswahl stabil.
Ein neues Parent/Child-Tabellenmodell oder eine DB wuerde mehr Bruchstellen schaffen als
Nutzen. Ursprungstasks werden ueber `archived`/`supersededBy` erhalten, nicht geloescht.

### 5. Marker-Grammatik

Empfehlung: **die sieben Marker oben, Batch-only, JSON-only, fail-closed**.

Begruendung: Das Set deckt Projektanlage, Projektupdate, Line-Item-Aenderung, Single-Task-
Fallback, Scanabschluss und Nutzer-Rueckfrage ab. Mehr Marker wuerden frueh Validierungs-
und UI-Komplexitaet erzeugen. Live-Streaming-Marker werden bewusst nicht uebernommen, weil
der Scan kein interaktiver Chat ist und atomare Persistenz wichtiger ist als Sekunden-
Responsiveness.

### 6. UI

Empfehlung: **index.html additiv erweitern, keine SPA-Neuschreibung**.

Projekt-Tasks bleiben Karten in der mittleren Liste. In der Karte erscheinen ein
Projekt-Badge, Anzahl offener/blockierter Line Items und ein Nutzer-Aktions-Indikator. Die
Detailansicht bekommt oberhalb der History eine PM-Sicht:

- Stand heute
- Geplant
- Nutzer-Aktion
- Probleme
- Risiken
- Warten auf
- Line Items mit Status, Owner, Datum und Evidenzlinks

Alte Single-Tasks werden unveraendert dargestellt.

### 7. Kostenkontrolle

Empfehlung: **Budget im Orchestrator erzwingen, nicht nur im Prompt formulieren**.

- ein Brain-Run pro Scan
- `--max-autopilot-continues 0`
- nicht benoetigte MCPs deaktivieren
- WorkIQ-Toolcalls aus `tool.execution_start` zaehlen und bei Budgetueberschreitung
  abbrechen
- v1-Budget: 10 WorkIQ-Calls, 25 Minuten Timeout, Salvage ab 200 Byte Assistant-Text
- `--max-ai-credits` nur zusaetzlich nutzen, falls die installierte Agency-Version es
  stabil durchsetzt

### 8. Prompt-Design

Empfehlung: **neues Brain-System-Prompt `docs/AGENCY_BRAIN_SCAN_SKILL.md` mit
Projektmanager-Denke**.

Struktur:

1. Rolle: Du bist der Projektmanager-Brain von Agent Zero.
2. Ziel: weniger Tasks, mehr Projektverstaendnis, klare Nutzer-Aktionen.
3. Wahrheitshierarchie: WorkIQ-Evidenz > Layer-2-State > alte Summaries > Vermutung.
4. Zeitlogik: aktuelle Signale gegen `lastEvidenceAt`, alte Infos als Historie labeln.
5. Projektkonsolidierung: bestehende Projekte zuerst aktualisieren, neue Tasks nur bei
   wirklich separatem Thema.
6. PM-Sicht: Stand, geplant, Nutzer-Aktion, Probleme, Risiken, Warten-auf.
7. Evidence-Regeln: keine Statusaenderung ohne Quelle.
8. Budget und Stop-Regeln.
9. Marker-Grammatik.
10. Self-check vor Antwort: Duplikate? Evidenz? Nutzer-Aktion klar? `SCAN_DONE`?

Der Seestrasse-Report wird nicht im Prompt erwaehnt. Seestrasse ist nur ein
Verifikationstest ausserhalb des Brain-Wissens.

## 6. Slice-Plan

### Slice 1: Brain-Runner-Skeleton

Dateien:
- neu `brain/agency-cli.js`
- neu `brain/brain-runner.js`
- optional `tests/unit/brain-runner.mjs`

Umfang: ca. 220-320 Zeilen.

Inhalt:
- Agency-Binary via `where.exe agency.exe` aufloesen und memoizen.
- Modell/Effort/Context pinnen.
- Prompt-Datei-Fallback ab 16 KB.
- NDJSON lesen, Assistant-Text aggregieren, Tool-Events zaehlen.
- Timeout, Salvage, single-settle, silent-failure-Struktur.

Testkriterium:
- Unit-Test mit Fake-Spawn: exit 0 + Assistant-Text = success.
- exit 0 + leerer Text = failure.
- Timeout mit >200 Byte Text = salvaged success.
- non-zero + 0 stdout + residual 0 stderr = `silentFailure:true`.

Reversibel:
- Modul ist ungenutzt, solange `runScanJob` nicht umgeschaltet ist.

### Slice 2: Atomic JSON Write und v5-Migration

Dateien:
- `server.js`
- `tests/unit/tasks-v5-migration.mjs`

Umfang: ca. 120-180 Zeilen.

Inhalt:
- `writeTasksAtomic(data)` mit tmp + fsync + rename + `.bak`.
- `migrateToV5()` additiv.
- Root `brain` ergaenzen.
- Bestehende 76 Tasks als `schemaVersion:5`, `taskType:"single"`, `archived:false`,
  `lineItems:[]`, `sourceRefs:[]` migrieren.

Testkriterium:
- Fixture v4 wird zu v5 migriert, Task-Anzahl bleibt gleich.
- Keine bestehenden Kernfelder gehen verloren.
- Migration ist idempotent.

Reversibel:
- Backup `tasks.json.v4-<timestamp>.bak`.
- Entfernen der v5-Felder stellt v4-nahe Struktur wieder her.

### Slice 3: Marker-Parser und Applier

Dateien:
- neu `brain/marker-parser.js`
- neu `brain/marker-applier.js`
- `tests/unit/brain-markers.mjs`

Umfang: ca. 250-350 Zeilen.

Inhalt:
- Fence-aware Batch-Parser.
- Schema- und Referenzvalidierung.
- `PROJECT_NEW`, `PROJECT_UPDATE`, `LINEITEM_NEW`, `LINEITEM_UPDATE`,
  `TASK_NEW`, `TASK_UPDATE`, `SCAN_DONE`, `ASK_USER`.
- Ein Applier-Durchlauf mutiert eine geladene JSON-Struktur und schreibt erst am Ende.

Testkriterium:
- Gueltige Marker erzeugen Projekt mit Line Items und SourceRefs.
- Ungueltige Referenzen werden verworfen.
- Superseded Ursprungstasks werden `archived:true`, aber nicht geloescht.
- Marker in Code-Fences werden ignoriert.

Reversibel:
- Parser/Applier ist isoliert und kann per Feature-Flag deaktiviert werden.

### Slice 4: Brain-System-Prompt und State Renderer

Dateien:
- neu `docs/AGENCY_BRAIN_SCAN_SKILL.md`
- neu `brain/render-scan-state.js`
- `tests/unit/render-scan-state.mjs`

Umfang: ca. 180-260 Zeilen plus Prompt.

Inhalt:
- Kompakter State Renderer fuer offene Projekte, Single Tasks, archivierte Quellen und
  Scan-Anker.
- Prompt mit PM-Denke und Marker-Grammatik.
- Keine Seestrasse-Fakten im Prompt.

Testkriterium:
- Renderer enthaelt alle offenen Tasks, aber kuerzt History kontrolliert.
- Renderer erzeugt fuer Seestrasse-Fixture nur vorhandene Task-/Quelleninfos, keine
  einkodierten Grundwahrheitsfakten.

Reversibel:
- Nur neue Dateien, kein Verhalten aktiv.

### Slice 5: Neuer Brain-Scan-Endpoint hinter Flag

Dateien:
- `server.js`
- neue Tests fuer Applier-Integration

Umfang: ca. 180-260 Zeilen.

Inhalt:
- `POST /api/brain/scan` oder interne Funktion `runBrainScanOnce(job)`.
- Feature-Flag `AGENT_ZERO_SCAN_ENGINE=legacy|agency`.
- Legacy-Scan bleibt Default bis Tests gruen sind.
- Brain-Run schreibt nur ueber Marker-Applier.

Testkriterium:
- Mit Fake-Brain-Output wird `tasks.json` korrekt aktualisiert.
- Bei invalidem Output bleibt `tasks.json` unveraendert ausser einem Fehler-History-Eintrag.
- Bei `ASK_USER` wird Job als `awaiting_input` markiert, ohne halbe Migration.

Reversibel:
- Flag zurueck auf `legacy`.

### Slice 6: Scan-Job auf Agency umschalten

Dateien:
- `server.js`
- `Start-WorkIQ-Scan.ps1`
- `index.html` nur fuer Phasenlabels

Umfang: ca. 100-160 Zeilen.

Inhalt:
- `runScanJob` nutzt bei `AGENT_ZERO_SCAN_ENGINE=agency` den Brain-Scan.
- Scheduler ruft nicht mehr manuell Phase 1-4 auf, sondern `POST /api/jobs`
  mit `kind:"scan"` und `input.scanDays`.
- Gleichzeitig den heutigen `days`/`scanDays`-Bug beseitigen, falls Legacy noch genutzt wird.
- SSE-Phasenlabels anpassen.

Testkriterium:
- `Start-WorkIQ-Scan.ps1 -ScanDays 7` fuehrt zu einem Job mit `input.scanDays=7`.
- UI zeigt laufenden Scan und completed/failed stabil an.
- Legacy-Modus funktioniert weiterhin.

Reversibel:
- Scheduler-Script kann auf Legacy-Block zurueckgestellt werden.

### Slice 7: UI fuer Projekt-Tasks und Line Items

Dateien:
- `index.html`

Umfang: ca. 220-320 Zeilen CSS/JS/HTML in bestehenden Funktionen.

Inhalt:
- `renderTaskCard` zeigt Projekt-Badge, offene Line Items, blockierte Items,
  Nutzer-Aktion.
- `renderTaskDetail` rendert `pmStatus` und `lineItems`.
- `buildTaskMeta` nutzt `sourceRefs` additiv.
- Suche durchsucht Line Items.
- Archivierte/superseded Tasks standardmaessig ausblenden, Toggle optional.

Testkriterium:
- Projekt-Task ohne Line Items bricht UI nicht.
- Projekt-Task mit 8+ Line Items bleibt lesbar.
- Alte Single-Tasks rendern unveraendert.

Reversibel:
- UI prueft nur neue Felder; Entfernen der Felder faellt auf alte Darstellung zurueck.

### Slice 8: Einmalige Bestandskonsolidierung

Dateien:
- `server.js`
- optional `scripts/migrate-projects-once.mjs` nur als manuell gestartetes Tool unter
  `scripts/`, falls nicht ueber API.

Umfang: ca. 120-200 Zeilen.

Inhalt:
- Endpoint/CLI `brain-migrate-existing-projects` rendert alle 76 Tasks und laesst den
  Brain Projektmarker erzeugen.
- Dry-run-Modus schreibt `docs/gremium/migration-preview-<timestamp>.json` oder
  `tests/runs/...`, nicht `tasks.json`.
- Apply-Modus schreibt Backup und archiviert Ursprungstasks via `supersededBy`.

Testkriterium:
- Task-Anzahl nach Apply ist >= vorher, weil Ursprungstasks erhalten bleiben.
- Seestrasse-Fragmente werden in genau einen Projekt-Task konsolidiert.
- Undo anhand Backup oder durch Clearing `archived/supersededBy` moeglich.

Reversibel:
- Backup wiederherstellen oder generated project tasks entfernen und Ursprungstasks
  entarchivieren.

### Slice 9: SDK- und WorkIQ-Subprozess aus Kernpfad entfernen

Dateien:
- `server.js`
- `package.json`
- `mcp.json`
- `docs/*_SKILL.md` optional umbenennen/archivieren

Umfang: ca. 300-500 Zeilen Entfernung/Umstellung, in kleinen Commits.

Inhalt:
- `/api/consolidate` als Legacy markieren oder auf Brain-Marker-Flow umstellen.
- `/api/tasks/:id/log`, `/correct`, `/review` und intelligente Suche auf denselben
  Agency-Runner umstellen oder explizit als Legacy-Fallback flaggen.
- Erst wenn keine aktive Route mehr `CopilotClient`, `askWorkIQDirect`,
  `ask_work_iq` oder `parallel_search` braucht: WorkIQ-Subprozesscode entfernen.
- `@github/copilot-sdk` und `@microsoft/workiq` aus `package.json` entfernen.
- `mcp.json` entweder entfernen oder dokumentieren, dass Agency `~/.copilot/mcp-config.json`
  nutzt.

Testkriterium:
- `rg "@github/copilot-sdk|CopilotClient|@microsoft/workiq|startWorkIQMCP"` findet keine
  aktive Laufzeitnutzung mehr.
- Server startet, `/api/health` bleibt kompatibel oder dokumentiert `wiqPid:null` nur nach
  Anpassung der Diagnose-Tools.

Reversibel:
- Erst nach stabilem Agency-Scan mergen. Vorher bleiben Legacy-Flags aktiv.

### Slice 10: Live-Verifikation und Handover

Dateien:
- keine zwingenden Code-Dateien
- Testnotizen unter `tests/runs/` oder Gremium-Ergebnis

Umfang: 1-2 Live-Scan-Laeufe.

Testkriterium:
- Agency-Brain scannt live mit WorkIQ 1.0.0.
- Kein eigener WorkIQ-0.2.8-Prozess wird fuer den Scan gestartet.
- Scan erzeugt/aktualisiert Projekt-Tasks mit Evidenzlinks.
- Kosten-/Toolcall-Zahlen werden im Job-Ergebnis sichtbar.

Reversibel:
- Backup wiederherstellen und `AGENT_ZERO_SCAN_ENGINE=legacy`.

## 7. Migrationsplan Bestandsdaten

1. **Backup**
   - Vor jeder Migration `tasks.json.v4-<timestamp>.bak`.
   - Optional `jobs.json` ebenfalls sichern.

2. **Schema-Migration**
   - Alle 76 bestehenden Tasks bleiben erhalten.
   - Additive v5-Felder werden gesetzt.
   - Kein Task wird in diesem Schritt semantisch gruppiert.

3. **Dry-run-Projektkonsolidierung**
   - Brain erhaelt alle v5-Tasks mit Summaries, Titeln, Quellen und Links.
   - Brain darf WorkIQ verwenden, muss aber jede neue PM-Aussage mit SourceRefs belegen.
   - Output wird validiert und als Preview abgelegt.

4. **Apply**
   - Neue Projekt-Tasks werden angelegt.
   - Ursprungstasks werden `archived:true` und `supersededBy:<projectTaskId>`.
   - `supersedesTaskIds` am Projekt verweist auf alle konsolidierten Ursprungstasks.
   - `history` der Ursprungstasks bekommt `type:"superseded"` mit Ziel-Projekt.

5. **Seestrasse-Spezialfall nur als Verifikation**
   - Der Brain bekommt keine Grundwahrheit.
   - Erwartung nach Apply: die Seestrasse-Fragmente landen in einem Projekt-Task mit
     mehreren Line Items und Evidenzquellen.

6. **Undo**
   - Entweder Backup zurueckspielen.
   - Oder alle durch Migration erzeugten Projekt-Tasks entfernen und bei Ursprungstasks
     `archived:false`, `supersededBy:null` setzen.

## 8. Testszenarien

### Hermetische Unit-Tests

- v4->v5 Migration erhaelt 76 Fixture-Tasks ohne Feldverlust.
- Marker-Parser ignoriert Code-Fence-Marker.
- Marker-Applier archiviert Ursprungstasks, loescht sie nicht.
- Projektupdate ohne Evidence wird verworfen.
- Brain-Runner Fake-Spawn deckt Success, Empty Output, Timeout Salvage, Silent Failure ab.

### UI-Tests

- Fixture mit einem Projekt-Task und 10 Line Items rendern.
- PM-Sicht zeigt genau die sechs benoetigten Bereiche.
- Suche findet Text aus `lineItems.currentState`.
- Archivierte Ursprungstasks sind standardmaessig nicht sichtbar, koennen aber per Toggle
  oder API noch gefunden werden.

### Live-Verifikation, generisch formuliert

Ein bekanntes reales Projekt mit vielen Email-/Teams-Signalen wird gescannt. Erfolg:

- Das Projekt erscheint als ein Projekt-Task, nicht als viele neue Single-Tasks.
- Mindestens zwei Workstreams werden als Line Items erkannt.
- Kritische Blocker werden unter `problems` oder `userActions` sichtbar.
- Terminrisiken werden unter `risks` sichtbar.
- Jede Statusaussage hat SourceRefs mit Datum/Link.
- Neue Signale bei Folgescan aktualisieren bestehende Line Items statt neue Tasks zu
  erzeugen.

### Seestrasse-Verifikation

Ohne diese Fakten in Prompt oder Code zu hinterlegen, muss der Live-Scan fuer das Projekt
"Zurich Seestrasse / Zurich See" erkennen:

- ein Projekt-Task statt der vorhandenen verstreuten Einzel-Tasks
- zwei Haupt-Workstreams: AV/MTR-Refresh und LAN/Verkabelung
- August-Fenster fuer Verkabelung
- ein kritischer Beschaffungs-/PO-/Onboarding-Blocker, falls in WorkIQ-Evidenz auffindbar
- Patch-Panel-Lieferzeit als Terminrisiko, falls in WorkIQ-Evidenz auffindbar
- offene Nutzer-Aktion(en) fuer Martin nur mit Evidenz

## 9. Risiken und Gegenmassnahmen

| Risiko | Gegenmassnahme |
|---|---|
| Agency/WorkIQ Login oder EULA blockiert headless | Preflight-Run, stderr/result auswerten, Fehler im Job anzeigen, Legacy-Flag behalten bis Preflight stabil ist |
| Falsche Projekt-Merges | Ursprungstasks nur archivieren, nie loeschen; Evidence-Pflicht; Undo ueber Backup und `supersededBy` |
| Marker-Drift | Kleine Grammatik, Batch-only, fail-closed, Audit-Log fuer verworfene Marker, kein Coercing in v1 |
| Kosten steigen | Ein globaler Run, Toolcall-Budget im Orchestrator, MCPs deaktivieren, Timeout, PremiumRequests im Job-Ergebnis |
| Kontext wird zu gross | Kompakter Renderer, History begrenzen, Prompt-Datei ab 16 KB, spaeter erst Hybrid-Repair |
| Microsoft Search Lag | Scan-Prompt verwendet breite Fenster, Brain filtert selbst nach Datum, `lastEvidenceAt` statt "today" |
| Sleep/Wake unterbricht Run | Timeout-Watchdog, strukturierte Fehlerfelder, kein Session-Drop noetig da fresh runs |
| UI wird ueberladen | Projekt nur als ein normaler Task; PM-Sicht kompakt; Line Items einklappbar |
| Diagnose-Tools erwarten `wiqPid` | Health-Vertrag bewusst anpassen oder bis SDK-Removal `wiqPid` kompatibel lassen |
| Scheduler startet doppelt | bestehende Lockfile-/Task-Scheduler-Regeln nicht aendern; keine breite Prozessbereinigung |

## 10. Bewusst weggelassen

- Keine neue Datenbank, kein Vector Store, kein Embedding-Index.
- Keine React/Vue/Frontend-Neuschreibung.
- Kein per-Projekt-Brain als Default.
- Keine persistenten Brain-Sessions in v1.
- Keine Live-Stream-Marker-Anwendung und kein Stream/Batch-Ledger.
- Kein Marker-Coercing in v1.
- Keine Learning-Wiki, Mail-Bridge, volle BrainRegistry oder Task-Zero-Projektordnerstruktur.
- Keine hartkodierten Seestrasse-Fakten.
- Keine Parallelisierung alter Phase-3-Checks.
- Kein breit gefasstes Prozess-Killing nach Namen wie `copilot`, `workiq` oder `node`.

## 11. Kurzempfehlung

Der erste produktive Meilenstein ist nicht "alle SDK-Routen entfernen", sondern:

1. v5-Store additiv einfuehren,
2. einen globalen Agency-Brain-Scan hinter Flag bauen,
3. Projekt-Tasks in der UI darstellen,
4. Bestandsdaten per Dry-run/Apply konsolidieren,
5. erst nach stabiler Live-Verifikation die Legacy-SDK-/WorkIQ-Pfade entfernen.

Damit wird das eigentliche Nutzerproblem geloest: ein reales Projekt wird zu einem
Projekt-Task mit Line Items und PM-Sicht, statt als E-Mail-Stapel in der Task-Liste zu
landen.
