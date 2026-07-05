# Agency-Copilot-Auditor: Unabhängiger Plan + adversariale Risiko-Sicht

**Rolle:** Unabhängiger Auditor · **Branch-Kontext:** `feature/agency-brain` · **Datum:** 2026-07-05
**Basis:** Eigene Code-Stichproben (server.js, index.html, tasks.json, docs/\*_SKILL.md, `E:\Task_Zero 03`\*)
verifiziert; MISSION.md/FACTS.md gelesen und punktuell am Code gegengeprüft.

> Dieser Plan ist bewusst eigenständig gebildet. Wo ich FACTS.md bestätige, sage ich es; wo ich
> abweiche oder verschärfe, ist es markiert. Es folgen **Empfehlungen (je eine)**, keine Optionslisten.

---

## 0. Verifikationsnotizen (was ich selbst nachgeprüft habe)

| Behauptung (FACTS) | Mein Befund am Code | Urteil |
|---|---|---|
| Phase 1 ohne LLM, 2 NL-Queries, jedes Item `action:'new'` | server.js:2596–2597, 2659/2675 | **bestätigt** |
| Merge ist destruktiv | server.js:3590 löscht Secondary-Tasks; 3459–3508 flacht auf 1 Freitext-Summary ab | **bestätigt + verschärft** (s. u.) |
| PS1 sendet `days`, Server liest `scanDays` | Start-WorkIQ-Scan.ps1:122 `{"days":…}` vs server.js:2560 `req.body?.scanDays` | **bestätigt** (Parameter wirkungslos) |
| CONSOLIDATE primt gegen Projektgruppierung | CONSOLIDATE_SKILL.md:20 „LAN repair Seestrasse + Power outage Seestrasse | do not merge" | **bestätigt** |
| „≥8 Tasks dasselbe Projekt" | tasks.json: **48** Kandidaten über Zurich/Seestrasse/verwandte Keys, verteilt auf **mehrere** Projekte | **abweichend — gravierender** |
| copilot-cli.js ~300 Z. verbatim übernehmbar | `E:\Task_Zero 03\copilot-cli.js` = 310 Z., sauber gekapselt | **bestätigt** |
| WorkIQ via `~/.copilot/mcp-config.json` geerbt | **nicht direkt prüfbar** — `~/.copilot` ist durch Content-Exclusion-Policy gesperrt | **Annahme aus FACTS** (Slice 0 verifiziert es live) |

**Datenlage tasks.json:** 76 Tasks (schema v4), 739 History-Einträge gesamt, 28 Tasks mit `ambiguities`,
3 mit `additionalLinks`, **0** mit `noMergeWith` (Feld existiert, aktuell leer). Größter Kandidat
(`3e249f13…`): 2404-Zeichen-Summary, **150** History-Einträge, **21** additionalLinks — bereits ein
de-facto Projekt-Task, per Hand gepflegt. Status-Verteilung: new 30, in-progress 21, done 13, updated 7, on-radar 5.

**Der zentrale unabhängige Befund:** Die 48 Kandidaten bilden **nicht ein** Projekt, sondern mindestens
Seestrasse-AV/MTR · Seestrasse-LAN-Verkabelung · Radon-Meetingraum · Circle-MPR · diverse PO-Approvals ·
Netzwerk-Incidents (SMARTS-False-Positive, Switch-Port-Unblock). Sie teilen **Entitäten** (Gebäude, POs,
Switches), sind aber **verschiedene Workstreams**. Damit ist die Kernaufgabe **Clustering mit korrekten
Grenzen** — und Übermerging ist genauso schädlich wie Fragmentierung. Ein naives „merge alle Zurich-Tasks"
erzeugt einen Müll-Mega-Task. Das prägt die gesamte Architektur unten.

---

## 1. Ziel-Architektur (Kurzform, je eine Empfehlung)

### 1.1 Grundentscheidung: Projekt-Layer ÜBER Tasks, nicht Merge-Destroy
**Empfehlung:** Ein `Project` ist eine **neue Entität**, die Member-Signale/Tasks als **Line Items
referenziert** — Tasks werden **nicht gelöscht**, sie werden zur Evidenz-Spur. Die Projektmanager-Sicht
(G3) ist **abgeleitet** und wird bei jedem Brain-Run frisch aus den Membern erzeugt (Layer-2-Disk-Wahrheit).

Begründung (adversarial): Der heutige Merge (server.js:3510–3593) löscht Secondary-Tasks und presst alles
in **eine** Freitext-Summary — das vernichtet 150-Eintrag-Historien, 21 Links, `ambiguities`, Quell-Attribution
und ist irreversibel. Ein additiver Projekt-Layer ist **verlustfrei und umkehrbar** (Unlink → Task steht
wieder allein). Das ist die direkte Antwort auf das Migrationsverlust-Risiko.

### 1.2 Brain-Topologie
**Empfehlung:** Ein einziges `brain.js` (~200–300 Z.), das `copilot-cli.js` **verbatim** übernimmt und den
Spawn-Envelope aus dem Guide portiert (File-Context >16 KB, Settle+Salvage ≥200 B, strikter Erfolg =
exit 0 + Text, `silentFailure`-Feld, `killTree`, agency-banner-Herausrechnung). Engine = `agency copilot`,
Modell gepinnt `claude-opus-4.8`, WorkIQ **geerbt** aus `~/.copilot/mcp-config.json` (kein selbst-gespawnter
0.2.8-Subprozess mehr). Genau **ein großer Brain-Run pro Scan** (projekt-scoped, s. 1.4), **nicht** pro Task.

Begründung (Kosten, adversarial): FACTS misst ~15 premiumRequests pro trivialem Run. Ein Per-Task-Brain
(heute: SDK-Session pro Task, server.js:2947) skaliert auf 76×15 ≈ **1140 Requests/Scan** — ruinös. Wenige
große Runs sind Pflicht, nicht Geschmack.

### 1.3 Sessions
**Empfehlung:** **Disposable `--name <uuid>` pro Run, KEIN `--resume`.** Bewusste Abweichung von Task Zero 03.

Begründung: Layer-2-Disk ist die Wahrheit; Agent Zero läuft nur 2×/Tag. Kein Resume ⇒ die gesamte
Silent-Failure/Resume-Corruption-Recovery-Klasse (Guide §6) entfällt, ebenso Session-Store-Reasoning.
Der einzige Preis (Store-Wachstum ~730 Sessions/Jahr) ist tolerierbar.

### 1.4 Datenmodell (tasks.json bleibt Store, schema v4 → v5, additiv)
**Empfehlung:** Ein neues Top-Level-Array `projects[]`. Tasks bekommen optional `projectId` (Rück-Referenz).
Discovery schreibt Roh-Signale in einen `signals[]`-Inbox statt sofort Tasks zu erzeugen.

```jsonc
// projects[] Eintrag (abgeleitete pmView wird pro Run neu erzeugt)
{
  "id": "proj-<slug>",
  "name": "Seestrasse 356 — LAN-Neuverkabelung",
  "aliases": ["Zurich See", "Seestrasse cabling", "…"],   // für Signal-Zuordnung
  "status": "active|done|on-hold",
  "pmView": {                                             // G3, alle 6 Felder Pflicht
    "standToday":   "<1-3 Sätze, Stand heute>",
    "planned":      [{ "text": "…", "date": "2026-08-17", "evidence": "<link>" }],
    "userMustAct":  [{ "text": "PO für Ottomüller fehlt", "evidence": "<link>", "confidence": "high" }],
    "problems":     [{ "text": "…", "evidence": "<link>" }],
    "risks":        [{ "text": "Patch-Panel 6–11 Wo. Lieferzeit", "evidence": "<link>" }],
    "waitingOn":    [{ "text": "Colt/WAN-Entscheid offen seit 09.06.", "evidence": "<link>" }]
  },
  "lineItems": [                                           // Teilthemen
    { "id": "li-…", "title": "Patch-Panel 2129", "status": "at-risk",
      "lastEvidenceLink": "<link>", "lastEvidenceDate": "…", "sourceTaskIds": ["…"] }
  ],
  "sessionName": "<uuid>", "createdAt": "…", "updatedAt": "…"
}
```

Tasks mit `projectId` verschwinden per Default aus der flachen Liste (Toggle „show absorbed"), bleiben aber
als volle Evidenz erhalten (History, Links, ambiguities intakt). Rollback = `projects[]` leeren +
`projectId` löschen. **Nichts wird zerstört.**

### 1.5 Marker-Protokoll (batch-only, fail-closed, minimal)
**Empfehlung:** Vier Marker, Single-Line-JSON, **nur** Batch-Parse des finalen Assistant-Textes,
Schema-Validierung fail-closed, ungültiges wird **gedroppt + Audit-Log**. Kein Stream-Apply, kein
`marker-coerce` (vorerst).

```
[PROJECT_UPSERT]   {"id","name","aliases","status","pmView":{…}}      // ersetzt Identität+pmView in-place
[LINE_ITEM_UPSERT] {"projectId","id","title","status","evidenceLink","evidenceDate","sourceSignalId"}
[ASSIGN_SIGNAL]    {"signalId","projectId","lineItemId"|null}          // Supersede: hängt Signal an, kein neuer Task
[NEEDS_REVIEW]     {"kind":"signal|project","ref","question","confidence":"low"}
```

**Evidenz-Gate (Kern-Anti-Halluzination, s. §3):** Jeder `status`-wechselnde `[LINE_ITEM_UPSERT]` MUSS ein
`evidenceLink` tragen, das auf einen dem Server **bekannten** Signal/Task-Link zeigt. Fehlt/unbekannt ⇒
Marker gedroppt. Der Brain kann „PO nicht erstellt" nur behaupten, wenn er die Quelle zitiert.

### 1.6 UI-Ansatz
**Empfehlung:** Eine **Projekt-Sektion oben** in der bestehenden SPA: Projekt-Cards, aufklappbar in die
6 festen pmView-Sektionen; jede Zeile mit ihrem Evidenz-Link + Confidence/needs-review-Badge. Flache
Nicht-Projekt-Tasks bleiben darunter. Wiederverwendung von `renderMarkdown()` (index.html:3507) + Card-CSS.
Kein Framework, minimales neues Rendering.

Begründung (adversarial): Die feste 6-Sektionen-Struktur ist **kein Freitext** — sie ist maschinell prüfbar
(G3-Abnahme) und verhindert, dass der Brain die PM-Sicht als Prosa halluziniert.

---

## 2. Slice-Plan (nummeriert, testbar, reversibel)

Jede Slice ist hinter einem Flag/additivem Schema/Git isoliert; die laufende App bleibt bis Slice 8 im
Alt-Verhalten. „DoD" = Definition of Done.

**Slice 0 — GO/NO-GO-Gate: Headless-Smoke agency + WorkIQ (kein Code-Change).**
Probe: `agency copilot -p "Use the workiq 'ask' tool to answer: what is today's date in my mailbox timezone?" --allow-all-tools --output-format json --stream on`.
DoD: `session.mcp_servers_loaded` enthält `workiq` **und** eine echte Antwort **und** exit 0.
Reversibel: read-only. **Bei Fehlschlag (EULA/Login blockt headless) STOP — auf SDK bleiben, G1 nicht bauen.**

**Slice 1 — Spawn-Fundament.** Port `copilot-cli.js` + minimales `brain.js` (File-Context, Settle+Salvage,
strikter Erfolg, `silentFailure`-Feld, killTree, agency-banner). Flag `AZ_BRAIN=off` default.
DoD: Unit-Tests mit Mock-Spawn (Injection-Seam wie TZ03 `_spawnFn`); App-Verhalten unverändert.
Reversibel: neuer Code, nicht verdrahtet.

**Slice 2 — Datenmodell v5 (additiv).** `projects[]`, `signals[]`, `task.projectId`; `saveAtomic`
(tmp+fsync+rename+bak). Read-Pfad toleriert Abwesenheit. Migration initial No-Op (leere Arrays).
DoD: bestehende 76 Tasks laden/rendern unverändert; Round-Trip-Test.
Reversibel: rein additives Schema.

**Slice 3 — Marker-Parser + Validatoren (pure module).** Batch-only Grammatik, fail-closed Schema +
referenzielle Integrität (kennt IDs), Audit-Log. Noch nicht verdrahtet.
DoD: Tabellen-Tests inkl. gedroppter Marker (fehlendes evidence, unbekannte projectId).
Reversibel: isoliertes Modul.

**Slice 4 — `POST /api/projects/reconcile` (dry-run-fähig).** Baut kompakten Layer-2-Doc aus
`projects[]` + unzugeordneten `signals[]`, fährt **einen** Brain-Run, parst Marker, wendet via Validatoren an,
`saveAtomic`. `?dryRun=1` gibt nur vorgeschlagene Marker zurück (nichts angewandt).
DoD: gegen Fixture (mock WorkIQ) deterministische Marker; dry-run mutiert nichts.
Reversibel: neuer Endpoint, manuell getriggert.

**Slice 5 — Signal-Inbox.** Phase-1-Discovery schreibt Signale in `signals[]` statt Auto-Tasks
(Flag; Alt-Pfad default). Fix `days`/`scanDays`-Bug (server.js:2560 ODER PS1:122 angleichen).
DoD: Scan füllt Inbox; keine Task-Explosion; alter Pfad weiter nutzbar.
Reversibel: Flag.

**Slice 6 — UI Projekt-Sicht (read-only).** pmView-6-Sektionen + Line Items + Evidenz-Links + Badges.
DoD: Snapshot-Render eines Fixture-Projekts; auf einem Screen erfassbar.
Reversibel: additives Rendering, hinter Feature-Flag im Frontend.

**Slice 7 — Migration der Bestandsdaten (mensch-reviewt).** `reconcile?dryRun=1` über die 76 Tasks →
Cluster-Vorschläge → Martin bestätigt/korrigiert → apply. Tasks behalten, `projectId` gesetzt.
DoD: `.bak` vor Lauf; Rollback-Prozedur dokumentiert + getestet (projects leeren, projectId löschen).
Reversibel: non-destruktiv per Konstruktion.

**Slice 8 — Scheduler-Verdrahtung.** 07:00/11:00-Scan ruft nach Discovery **einmal** `reconcile`.
Per-Task-Enrich bleibt als manueller Fallback.
DoD: geplanter Lauf erzeugt/aktualisiert Projekte; Single-Instance-Lock + `/api/health`-Contract
(`repoPath`,`wiqPid`) unangetastet.
Reversibel: Scheduler-Skript-Flag.

**Slice 9 — Aufräumen.** Toten SCAN_DISCOVERY_SKILL-Pfad korrekt verdrahten oder entfernen;
CONSOLIDATE-Anti-Beispiel (Seestrasse) tilgen; Per-Task-SDK-Phasen für projekt-verwaltete Tasks
deaktivieren (für standalone erhalten).
DoD: keine Regression Task-CRUD/UI/Scan; Doku (ARCHITECTURE/CHANGELOG) aktualisiert.
Reversibel: Git.

---

## 3. Adversariale Risikoliste (Szenario → Gegenmaßnahme → Test)

**R1 — EULA/Login blockt Headless (G1-Killer).**
→ Slice 0 als hartes Gate vor jedem Bau; live `mcp_servers_loaded=workiq` + echte Antwort fordern.
→ Test: Probe-Skript in CI-artigem One-Shot; Assertion auf beide Signale. Bei Fehlschlag SDK-Fallback behalten.

**R2 — Premium-Request-Kosten explodieren.**
→ Genau ein projekt-scoped Brain-Run pro Scan; niemals per Task. `--max-ai-credits`/Timeout als Deckel;
`usage.premiumRequests` pro Run loggen und gegen Budget alarmieren.
→ Test: Kostenzähler-Assertion in Reconcile-Integrationstest (Runs pro Scan ≤ kleine Konstante).

**R3 — 32-KB-CreateProcess-Limit / Kontext-Budget bei 76 Tasks × 739 Historien.**
→ Layer-2-Doc ist eine **kompakte Projektion** (Projekt, Line-Item-Titel + 1-Zeilen-Status + letztes
Evidenz-Link + offene Frage) — **nicht** Roh-Tasks. Voll-History bleibt auf Disk; Brain liest gezielte
Task-JSONs on demand via Read-Tool (--add-dir Projektordner). File-Context-Pattern >16 KB verpflichtend.
→ Test: Doc-Größe für die realen 76 Tasks messen, Assertion < Schwelle; Fuzz mit künstlich aufgeblähten Historien.

**R4 — Brain halluziniert Projekt-Status (das gefährlichste inhaltliche Risiko).**
→ **Evidenz-Gate**: jeder Status-wechselnde Marker braucht `evidenceLink` auf bekannten Link, sonst Drop.
→ **Confidence + fail-closed**: unsichere Zuordnungen ⇒ `[NEEDS_REVIEW]`, nichts wird angewandt.
→ **Layer-2-Disziplin**: „Disk schlägt Session-Memory" im System-Prompt.
→ Test: Fixture mit einem Signal ohne belastbaren Beleg → assert der Status bleibt unverändert + landet in Review.

**R5 — Übermerging (Radon/AV/Cabling/Circle in einen Mega-Task).**
→ Ein Signal/Task gehört zu **höchstens einem** Projekt; Projekt-Grenze ist eine reviewte, umkehrbare
Entscheidung, nicht Auto-Jaccard. Low-Confidence-Zuordnung ⇒ Review-Queue statt Auto-Apply.
→ Test: Fixture mit 3 realen Nachbar-Workstreams (gleiche Location) → assert 3 Projekte, kein Cross-Assign.

**R6 — Untermerging / Re-Fragmentierung beim Folge-Scan.**
→ Supersede über `aliases[]`-Matching + `[ASSIGN_SIGNAL]`: neue Signale gehen zuerst gegen bestehende
Projekte, nur bei echtem Fehlschlag neues Projekt/Task.
→ Test: gleiche Nachricht in zwei aufeinanderfolgenden Reconciles → assert kein Duplikat, Line-Item-Update.

**R7 — Migration verliert History/Links/Attribution der ~48 Bestands-Tasks.**
→ Additiv, non-destruktiv: Tasks bleiben, `projectId` referenziert; Line-Items zeigen auf `sourceTaskIds`;
`.bak` vor Lauf; dry-run + Mensch-Review.
→ Test: vor/nach Migration Summen invariant (Σ history-Einträge, Σ Links) — nichts darf verschwinden.

**R8 — Silent-Failure (exit≠0 + 0 B) durch `agency`-stderr-Banner falsch klassifiziert.**
→ `residualStderrBytes()` (agency-banner.js) rechnet Banner heraus, bevor die 0-B-Signatur greift.
→ Test: TZ03-Bannerfixtures → assert residual=0; echter Fehler mit Banner+Text → residual>0.

**R9 — Autopilot-Continuation stoppt zu früh (Clustering-Run braucht mehrere WorkIQ-Turns).**
→ `--max-autopilot-continues` **klein-positiv** statt 0 (bewusste Abweichung von TZ03); begrenzt durch
Timeout+Salvage. Empirisch tunen.
→ Test: Reconcile-Run, der ≥3 WorkIQ-Suchen braucht → assert er terminiert mit vollständigen Markern, nicht mid-run.

**R10 — WorkIQ-Antwortqualität reicht nicht für Projekt-Rekonstruktion (bekannte Sent-Items/Inbox-Lücken).**
→ Brain arbeitet evidenzbasiert: keine belastbare Quelle ⇒ `waitingOn`/`NEEDS_REVIEW` statt Erfindung.
Bekannte Lücken (Sent-Items, Focused-Inbox) explizit im Prompt als Limit benennen.
→ Test: Fixture, in der eine Schlüssel-Mail fehlt → assert Projekt zeigt die Lücke offen, statt sie zu erfinden.

**R11 — SPA-UI-Regression (bestehende Task-CRUD/Merge/Ambiguity-Panels brechen).**
→ Projekt-Sicht additiv hinter Frontend-Flag; bestehende `renderTasks()`/`renderTaskDetail()` unverändert;
absorbierte Tasks nur ausgeblendet, nicht entfernt.
→ Test: Playwright-Smoke der Alt-UI (Create/Patch/Delete/Note/Merge) vor+nach; DOM-Regressionsvergleich.

**R12 — Doppelinstanz/Auth-Korruption (bestehende harte Regel).**
→ `acquireLockFileAtomic()` + path-restringierte Cleanups bleiben unangetastet; WorkIQ-Wechsel auf
CLI-vererbt reduziert sogar die Subprozess-Angriffsfläche.
→ Test: 3× paralleler Start → genau 1 überlebt; `/api/health` behält `repoPath`+`wiqPid`.

**R13 — Modell-Pin leckt aus interaktiver CLI-Session (`/model` des Nutzers).**
→ `--model`-Flag an argv-Front + `COPILOT_MODEL`-env gepinnt (copilot-cli.js Muster); Duplikat-Strip.
→ Test: mit poisoned `settings.json`/env spawnen → assert effektives Modell = Pin.

---

## 4. Abnahme-Testszenarien G2–G5 (generisch; Seestrasse nur als Verifikationsfall)

**Grundregel:** Automatisierte Tests prüfen **generische Invarianten** gegen **synthetische Fixtures**.
Der Seestrasse-Report (`seestrasse-status-report.html` in Task Zero 03) ist **ausschließlich menschliche
Abnahme-Messlatte** — **niemals** werden Seestrasse-Strings in Tests einkodiert.

**G2 — Projekt-Konsolidierung (ein Projekt = ein Task mit Line Items).**
Fixture: N synthetische Signale über M reale Projekte (Fantasienamen). Reconcile.
Assert: genau M Projekte; jedes Signal genau einmal zugeordnet; **kein** Signal verloren; Zuordnung
umkehrbar (Unlink → Signal/Task wieder standalone).
Seestrasse-Verifikation (manuell): Trennt es AV/MTR-Refresh von LAN-Verkabelung korrekt, **ohne** Radon/Circle
oder unabhängige Incidents hineinzuziehen?

**G3 — Projektmanager-Sicht.**
Assert (schema): jedes `pmView` hat alle 6 Felder; jede nicht-leere Zeile trägt `evidence`; UI rendert die
6 Sektionen auf einem Screen (Snapshot).
Seestrasse-Verifikation (manuell): Nennt „userMustAct" die fehlende PO und „risks" die Patch-Panel-Lieferzeit?

**G4 — Laufende Aktualisierung mit Evidenzpflicht.**
Fixture: ein Folge-Signal, das ein bestehendes Line-Item supersedet.
Assert: dieses Line-Item wird aktualisiert (Status + Evidenz angehängt); **kein** neues Projekt/Task; ein
Status-Marker **ohne** `evidenceLink` wird gedroppt (Beweis der fail-closed-Validierung).

**G5 — Seestrasse-Rekonstruktion (strukturell, ohne Einkodierung).**
Lauf gegen **eingefrorenes WorkIQ-Fixture** (mock; ein einmal aufgezeichneter Transcript-Satz als statisches
JSON). Assert generisch: ≥1 Projekt gebildet; alle 6 pmView-Sektionen befüllt; jede Statuszeile mit Evidenz;
≥1 `userMustAct` und ≥1 `risk` vorhanden; ≥2 Line-Items.
Menschliche Abnahme (separat, kein Test-Code): Vergleich gegen `seestrasse-status-report.html` — erkennt der
Brain die 2 Workstreams, die PO als kritischsten Blocker, das Patch-Panel-Risiko, Freeze-Ende 01.07.?

---

## 5. Explizite Anti-Overengineering-Liste (was bewusst NICHT gebaut wird)

Task Zero 03 ist ~226 KB server.js + 88 KB brain.js + ein riesiges `learning-*`-Subsystem. Das meiste ist
für Agent Zero die **falsche Abstraktion**:

- **KEIN** Learning-Wiki/Curator/Retrieval/Store (~300 KB in TZ03). Agent Zero braucht kein
  projektübergreifendes Lernen — nur den aktuellen Stand pro Projekt aus Disk.
- **KEINE** Recurring-Trigger / `[TICK_DONE]` / Drift-Zählung über `WORK_DONE`-Receipts. Der **Task
  Scheduler (07:00/11:00) bleibt die einzige Uhr**; der Agent plant sich nicht selbst.
- **KEIN** `marker-coerce` initial (TZ03: 15 KB Code + 45 KB Tests). Start mit fail-closed Batch-Parse;
  Coercion erst **nach nachgewiesenem Drift**.
- **KEIN** Stream+Batch-Ledger-Reconciliation. Batch-only Parse des finalen Textes ⇒ kein
  Doppel-Apply-Problem, das rekonziliert werden müsste.
- **KEIN** `--resume`/Session-Store-Management. Disposable `--name` pro Run (§1.3).
- **KEINE** neue DB / kein Framework. `tasks.json` bleibt Store (schema v5 additiv).
- **KEIN** mail-bridge, image-intake, canvas, brainstorm-synthesis, BrainRegistry-Klasse.
- **KEIN** Per-Task-Brain-Run (Kosten). Ein projekt-scoped Run pro Scan.
- **KEIN** Auto-Apply von Low-Confidence-Merges — immer Review-Queue.
- **NICHTS** aus dem Seestrasse-Report wird in App/Prompt/Tests einkodiert.

---

## 6. Direkte Antworten auf die adversarialen Fokusfragen

**„Wo wird der naheliegende Umbau scheitern?"**
Am wahrscheinlichsten: (a) Headless-EULA/Login (R1, deshalb Slice-0-Gate), (b) Kosten bei Per-Task-Denken
(R2), (c) Kontext-Budget durch Roh-Tasks statt kompakter Projektion (R3), (d) Übermerging der 48 heterogenen
Kandidaten (R5) — der von FACTS unterschätzte Kern.

**„Was am Task-Zero-03-Muster ist die falsche Abstraktion?"**
Das Recurring-Trigger/TICK_DONE-Lebenszyklusmodell und das Learning-Subsystem. Agent Zero ist scan-getrieben
und zustandsarm-pro-Projekt; es braucht Spawn-Envelope + Marker + Layer-2-Disk, nicht Selbst-Scheduling und
Cross-Projekt-Gedächtnis. Auch `--resume` ist für 2-Läufe/Tag unnötiger Komplexitäts-Import.

**„Wie verhindern wir halluzinierten Projekt-Status?"**
Evidenz-Gate (Status-Marker ohne bekannten Quell-Link wird gedroppt) + Confidence/`NEEDS_REVIEW` +
fail-closed Validierung + „Disk schlägt Session-Memory". Fehlende Belege ⇒ offene Frage, nicht Erfindung (R4/R10).

**„Was kann bei der Migration verloren gehen?"**
Bei destruktivem Merge: 150-Eintrag-Historien, 21 Links, `ambiguities`, Attribution, `noMergeWith`. Gegenmaßnahme:
additiver, non-destruktiver Projekt-Layer; Tasks bleiben als Evidenz; Summen-Invarianz-Test vor/nach (R7).

**„Wie verifizieren wir G2–G5 objektiv ohne Einkodierung?"**
Synthetische Fixtures + generische Invarianten in Tests; eingefrorenes WorkIQ-Mock-Fixture für G5; der
Seestrasse-Report bleibt **manuelle** Messlatte (§4).

---

## 7. Was ich NICHT verifizieren konnte (ehrliche Lücken)

- **`~/.copilot/mcp-config.json`**: durch Content-Exclusion-Policy für mich gesperrt — kein Workaround
  versucht. G1 stützt sich hier auf FACTS; **Slice 0 verifiziert es live** (einziger belastbarer Weg).
- **Premium-Request-Kosten pro echtem Reconcile-Run**: nur FACTS' 15-Requests-Trivialmessung vorhanden;
  ein Clustering-Run mit mehreren WorkIQ-Turns ist teurer — muss in Slice 4 empirisch gemessen werden (R2).
- **Headless-Continuation-Verhalten** bei mehrstufigen Tool-Ketten: FACTS beschreibt Autopilot-Ende via
  `task_complete`; das exakte `--max-autopilot-continues`-Tuning ist empirisch (R9).

---

*Ende des unabhängigen Auditor-Plans. Keine Code-Änderungen in dieser Phase — nur Analyse + Plan.*
