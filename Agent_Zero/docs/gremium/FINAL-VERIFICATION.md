FINAL: PASS

# Slice 10 — Live-Verifikation (Verifikations-Orchestrator, 2026-07-05)

Repo `E:\Work_IQ\Agent_Zero`, Branch `feature/agency-brain`. Alle sechs Serie-C-Kriterien
(C-1..C-6) bestanden unter produktionsäquivalenter Isolation. Die App-Datenintegrität blieb
über den gesamten Lauf perfekt erhalten (fail-closed; keine Task je gelöscht;
Σ-Invarianten nie gesunken).

**Wichtigster Befund vorab (Umgebungsartefakt, KEIN Agent-Zero-Defekt):** Die ersten zwei
Live-Scans schlugen nach je ~25 min mit „no markers" fehl. Ursache — via Minimal-Probe
eindeutig belegt — war NICHT der Agency-Brain-Code, sondern eine vom Server an das
gespawnte `agency copilot`-Kind vererbte Session-Identität (`AGENCY_SESSION_ID` /
`COPILOT_AGENT_SESSION_ID` = die Session dieses Verifikations-Orchestrators). Dadurch
*resumte* der Brain die kontrollierende Agency-Session statt eine frische zu starten und
gab Orchestrator-Text statt Scan-Marker aus. Nach Entfernen dieser Session-Variablen beim
Serverstart (= exakt der Produktionszustand unter Task Scheduler, der diese Variablen nicht
kennt) konvergierten alle drei folgenden Scans sauber mit `SCAN_DONE`. Details unten in
„Loop-Historie" und „Umgebungslimits".

---

## C-1 — Bestandskonsolidierung — PASS
Verifiziert am Ist-Stand von `tasks.json` (Slice-8-Apply bereits erfolgt, RESULT-CODEX-IMPL-4)
und live über drei Scans.
- [x] **Genau EIN aktiver Seestrasse-Projekt-Task**: `proj-seestrasse-356`; über alle drei
      Live-Scans blieb `seestrasse-Projekte = 1`, `Projekt-Tasks = 3` (kein Duplikat).
- [x] **Line Items decken ab**: „AV decommission, install & commissioning (MTR testing)",
      „Data recabling & patch panel sourcing", „CorpNet patching & room connectivity",
      „Focus rooms — network cables & touchpanel decisions", „August cabling works
      coordination (17–28 Aug 2026)", „PC relocation during August rebuild", „Supplier
      onboarding & invoice upload (Zimmerberg Elektro)" u.a. (9→10 Line Items). Deckt
      AV/MTR · LAN-Recabling · Patch-Panel/Kabelraum · CorpNet/CHD-Kontext ab.
- [x] **Genuine Fremd-Themen NICHT im Projekt**: „Zurich The Circle" und „MS Digital
      Enterprise CAB" sind separate Projekte; DELFT-MQFAB-GWS-Access, Robotics-Lab, Temp-
      Badges, SFP-Location, PO-Approval bleiben eigene Single-Tasks.
- [x] **Ursprungs-Tasks archiviert, keiner gelöscht, Σ-Invarianten grün**: 31 Ursprungs-
      Tasks mit `archived:true` + `supersededBy:"proj-seestrasse-356"`; `deletedTaskIds:[]`;
      Σ History 798→800, Σ Links 221→243 (nie gesunken); 0 Tasks entfernt über alle Scans.
- [x] **Dry-Run-Preview vor Apply vom Auditor geprüft**: `AUDIT-MIGRATION.md` Zeile 1
      `AUDIT: GO` (P4, agency copilot gegen die Grundwahrheit).
- **Live-Update-Verhalten (Brief-Zusatz „aktualisiert statt dupliziert")**: Scan #3 → 0
      neue Projekte, 2 aktualisiert; Scan #4 → 0 neue, 3 aktualisiert; Scan #5 → 0 neue, 1
      aktualisiert (aktualisierte diesmal Seestrasse selbst: +1 Line Item, +2 sourceRefs,
      ohne Duplikat).

## C-2 — PM-Sicht-Qualität (manuell gegen Grundwahrheit) — PASS
Messlatte: `E:\Task_Zero 03\...\seestrasse-status-report.html` (READ-ONLY). Bewertet auf
`proj-seestrasse-356.pmStatus`.
- [x] **Alle 6 Sektionen befüllt**: current 1 · planned 2 · userActions 5 · problems 3 ·
      risks 1 · waitingOn 3 (in der UI verifiziert).
- [x] **Kritischster Blocker in userActions/problems (mit Evidenz)**: problems[1] „Several
      rooms lack CorpNet connectivity … blocking MTR/CHD commissioning" (ev src-1f264332);
      userActions[5] „Sign off commissioned AV rooms for production" (ev src-650e8334).
      Nuance: Die in der Grundwahrheit am stärksten betonte Aktion „Issue the PO for the LAN
      cabling contractor" ist als Risiko+waitingOn (Patch-Panel-Lieferung) statt als
      knackige userAction abgebildet.
- [x] **Zentrales Terminrisiko in risks (mit Evidenz)**: risks[1] „Patch panel lead time of
      6–11 weeks threatens the August cabling schedule" (ev src-bd39f6be) — exakt das
      Terminrisiko der Grundwahrheit.
- [x] **Wartebedingungen mit Datum in waitingOn/planned**: planned[1] „August cabling works
      scheduled 17–28 Aug 2026"; planned[2] „AV Go-Live target 1 Jul 2026".
- [x] **Ausführungsfenster des zweiten Workstreams erfasst**: „17–28 Aug 2026" in planned[1]
      UND Line-Item „August cabling works coordination (17–28 Aug 2026)".
- [x] **Jede Aussage mit Evidenz-Ref**: jeder pmStatus-Eintrag trägt `{ev:src-...}` →
      sourceRefs mit Links; UI rendert 23 Evidenz-Links + 15 Confidence-Badges.
- Ehrliche Gaps (WorkIQ-Teams/IcM-Indexlücke, als Umgebungslimit dokumentiert, nicht
  wegoptimiert): WAN/Colt-Redundanz, Port-Freeze-bis-1-Jul (IcM 822105144) und Patricks
  Account-Reinstatement fehlen — allesamt vorwiegend Teams/IcM-Quellen; der Grundwahrheits-
  Report vermerkt selbst, dass Teams-Inhalte „could not be retrieved automatically because
  Work IQ's Teams indexing is incomplete". Kern-Blocker + Terminrisiko + Fenster + Datums-
  Gates sind vollständig mit Evidenz erfasst.

## C-3 — Laufende Aktualisierung (G4) — PASS
Zwei aufeinanderfolgende Live-Scans nach der Konsolidierung.
- [x] **Kein neues Seestrasse-Duplikat; neue Signale als Updates am Bestand**: Scan #3 hängte
      an bestehende Projekte an — Circle +2 evidenz-verlinkte sourceRefs (SAP-Invoice
      5735844555, 3 Jul; Zones-MPR-Concern, 30 Jun), CAB +1 (CAB-Meeting 30-Jun). Scan #4
      und #5 erzeugten 0 neue Projekte. Re-Fragmentierungs-Schutz bestätigt: der in Scan #3
      neu erzeugte Single „JIT-039008 DELFT-MQFAB GWS" wurde von Scan #4 nicht dupliziert
      (distinct vom pre-existierenden „JIT-038308 DELFT" Task).
- [x] **updatedAt aktualisiert; Delta dokumentiert**: `updatedAt` der betroffenen Projekte
      wechselte; `data.brain` Telemetrie (lastRunId/lastRunAt/lastOutcome/lastPremiumRequests/
      lastWorkIqCalls) je Scan fortgeschrieben; neue sourceRefs mit Datum+Link angehängt.
- [x] **Nicht-Seestrasse-Singles unverändert (keine Zwangs-Projektisierung)**: Bestehende
      Singles blieben Singles; neue genuine Fremd-Signale (GWS/DELFT, Robotics-Lab) landeten
      als Single-Tasks, nicht als Projekte.

## C-4 — Anti-Halluzination (Stichprobe, per workiq-ask) — PASS
5 Status-Aussagen aus `proj-seestrasse-356` unabhängig live gegen die Mailbox verifiziert.
- V1 risks „Patch panel 6–11 Wochen bedroht August-Fenster" → **SUPPORTED** (Ottomüller/
  Eindiguer 1./6. Jun „lead times up to eight weeks", Grundwahrheit 24-Jun „6-11 Woche").
- V2 problems „CorpNet fehlt nach Switch-Entfernung, blockiert MTR/CHD" → **PARTIAL/
  akzeptabel** (Komponenten belegt: CHDs fehlen/Räume nicht auf Produktion (Patrick 26 Jun),
  CorpNet-Switch-Policy; Kausalkette nur teilweise — Projekt führt sie mit confidence=medium).
- V3 problems „Zimmerberg/Eindiguer kein SupplierWeb-Login, Invoice 101616080 blockiert" →
  **SUPPORTED** (explizit, mehrere Quellen 9./11./15./24-29 Jun; „Once you manage to login we
  will settle PO101616080").
- V4 planned „17–28 Aug 2026" → **SUPPORTED** (explizit, 09-Jun-Mail „planned for 17 to 28
  August 2026" + Teams).
- V5 userActions „AV-Räume auf Produktion sign-off (Patrick)" → **SUPPORTED (core)** (Patricks
  Produktions-Sign-off-Wunsch belegt via V2-Zitat + Grundwahrheit SEP 3235; „AVLink"-Detail
  von dieser Query nicht gefunden, WorkIQ-Recall-Lücke, keine Fabrikation).
- [x] Fazit: 5/5 Aussagen mailbox-gedeckt oder korrekt bei confidence≤medium gehedged;
      **keine unbelegte Behauptung als harter Fakt** — exakt die geforderte Semantik.

## C-5 — Robustheit + Kosten (G6/D10) — PASS
- [x] **SCAN_DONE, Quote über ≥3 Läufe**: 3/3 isolierte Scans mit `scanDone:true`,
      `outcome:"success"`, `salvaged:false`, `parseErrors:[]`, `droppedMarkers:[]`.
- [x] **Laufzeit < 25 min; premiumRequests + workiqCalls geloggt ≤ Budget**: 6.5 / 7.9 / 3.8
      min; je Scan `premiumRequests:15`, `workIqCalls:3–4` (Soft-Budget 10, Hard-Kill 25) —
      in `jobs.json` + `data.brain`-Telemetrie geloggt.
- [x] **Kein WorkIQ-0.2.8-Subprozess im Agency-Modus**: `/api/health` `wiqPid:null` in
      Agency; Kontrast im Legacy-Modus `wiqPid` gesetzt (z.B. 26268, „Starting persistent MCP
      subprocess … workiq\bin\workiq.js").
- [x] **Legacy-Flag-Rückschaltung jederzeit**: Server ohne `AGENT_ZERO_SCAN_ENGINE=agency`
      → `scanEngine:"legacy"` + WorkIQ-0.2.8-Subprozess startet. (Unit-Test
      `legacy-route-guards.mjs` sichert die Guards zusätzlich statisch ab.)

## C-6 — UI (G3) — PASS
Live-DOM-Smoke via Playwright gegen die App (echte Daten).
- [x] **Projekt-Karte**: „Project"-Badge + „9 open · 2 blocked" (offene/blockierte Line
      Items) + „Du musst aktiv werden" (Nutzer-Aktions-Indikator) für Seestrasse.
- [x] **Detailpanel**: PM View mit allen 6 Sektionen (Stand heute/Geplant/Nutzer-Aktion
      nötig/Probleme/Risiken/Warten auf), 9–10 Line Items mit Status/Evidenz-Links, 23
      Evidenz-Links, 15 Confidence-Badges — auf einem Screen.
- [x] **Archived/superseded default ausgeblendet, per Toggle sichtbar**: 23 aktiv ↔ 79 mit
      Archiv (56 superseded-Badges), sauberes Zurück-Togglen.
- [x] **Alt-Funktionen regressionsfrei**: Suche über lineItems bewiesen (3 line-item-only
      Begriffe via `pmSearchText` gefunden, im Titel/Summary/pmStatus abwesend); Handler
      `updateTask`(Status)/`addNote`/`showAddTaskModal`/`addTask`/`deleteTask`/`setFilter`/
      `toggleArchivedTasks`/`onTaskSearch` alle vorhanden; 23 Status-Selects, 9 Status-Filter.
      Einziger Konsolenfehler: favicon-404 (harmlos).

---

## Loop-Historie
1. **Scan #1** (`19bef2ff…`, scanDays 7): FAIL nach 25:01 min, „Agency brain output had no
   markers" (`parseErrors:[]`). Fail-closed → `tasks.json` byte-identisch.
2. **Diagnose-Klassifikation**: Konvergenz-/Session-Verdacht. Loop-Runde 1: Skill gehärtet
   (Marker-zuerst + engeres WorkIQ-Budget), Retry mit scanDays 3.
3. **Scan #2** (`81b3082c…`, scanDays 3): FAIL identisch nach ~25 min. Fail-closed erneut →
   byte-identisch. Damit Workload/Prompt als Ursache ausgeschlossen.
4. **Minimal-Probe (kein Tool, 5-min-Timeout)**: 5-min-Timeout, 3 Phantom-Tool-Calls,
   `assistantText` = ORCHESTRATOR-Meta-Narration statt der geforderten Marker → Session-Bleed
   nachgewiesen. Env-Beleg: `AGENCY_SESSION_ID`/`COPILOT_AGENT_SESSION_ID` = Orchestrator-
   Session an das Kind vererbt.
5. **Fix (Harness/Umgebung, KEINE Agent-Zero-Code-Änderung)**: Server ohne Session-Identitäts-
   Variablen neu gestartet (= Produktionszustand). Probe konvergiert in 87 s mit
   `[NEEDS_REVIEW]`+`[SCAN_DONE]`. Skill-Härtung aus Runde 1 **revertiert** (nicht die Ursache);
   Working Tree sauber.
6. **Scan #3/#4/#5** (`2d3b1d7c…`/`7a00bbfe…`/`3d8be6a6…`): alle `SCAN_DONE`/`success`,
   0 Duplikate, existierende Projekte aktualisiert, genuine neue Singles angelegt.
7. **A5-Flip** in `Start-WorkIQ-Scan.ps1` + `START-AGENT-ZERO.bat` (default agency, env-
   Override für legacy erhalten); end-to-end verifiziert (`scanEngine:agency`).

## Umgebungslimits / Restpunkte (ehrlich)
- **Session-Bleed nur im verschachtelten Kontext**: Tritt ausschließlich auf, wenn Agent Zero
  als Nachfahre einer aktiven `agency copilot`-Session gestartet wird (= dieser Verifikations-
  Harness). In Produktion (Task Scheduler / START-AGENT-ZERO.bat, kein Agency-Vorfahr) sind
  die Session-Variablen abwesend → Isolation greift natürlich (durch Scan #3–#5 unter exakt
  diesem Zustand bewiesen). Kein Produktionsdefekt.
- **Optionale Härtungs-Empfehlung (nicht erforderlich, defense-in-depth für G6)**: In
  `brain/brain-runner.js`/`brain/agency-cli.js` könnte `buildAgencyEnv()` die Variablen
  `AGENCY_SESSION_ID`, `COPILOT_AGENT_SESSION_ID`, `AGENCY_LOG_SESSION_DIR`,
  `AGENCY_OPERATION_ID` aus dem Kind-Env entfernen, damit der Brain unabhängig vom Start-
  Kontext IMMER frisch isoliert. Bewusst NICHT selbst eingebaut (Kern-Code, kein
  Produktionsdefekt) — als Empfehlung dokumentiert.
- **WorkIQ-Teams/IcM-Indexlücke**: Einige rein Teams/IcM-basierte Seestrasse-Fakten
  (WAN/Colt, Port-Freeze, Account-Reinstatement) erscheinen nicht in der PM-Sicht. Bekanntes
  Umgebungslimit; der Grundwahrheits-Report vermerkt es selbst. Nicht wegoptimiert.

## Kosten
- Geloggte `premiumRequests`: 3 erfolgreiche Scans × 15 = **45** (in `jobs.json` + `data.brain`).
- Zusätzlich (nicht in Job-Ergebnissen erfasst, aber verbraucht): 2 timeout-Scans à ~25 min +
  2 Minimal-Proben. Diese liefen unter Opus-4.8/effort=high; ihr Premium-Verbrauch wurde vom
  fehlgeschlagenen Pfad nicht surfaced.
- `workIqCalls` je erfolgreichem Scan: 3–4 (deutlich unter Soft-Budget 10 / Hard-Kill 25).

## Datensicherheit
- Vor Scans: 79 Tasks / Σhistory 798 / Σlinks 221 / 3 Projekte / 56 archiviert / reviewQueue 0.
- Nach 3 erfolgreichen Scans: 81 Tasks / Σhistory 800 / Σlinks 243 / 3 Projekte / 56
  archiviert / reviewQueue 0. Keine Task je gelöscht; Σ-Invarianten monoton ≥.
- Sicherheitskopien (löschen nichts): tasks.PRE-SCAN / POST-SCAN3 / POST-SCAN4 / POST-SCAN5
  im Session-Ordner.

## Job-IDs (Referenz)
- FAIL: scan1 `19bef2ff-f66a-4d11-9a77-db9178ac70a4`, scan2 `81b3082c-d483-4792-8593-06b1fa81f6b1`
- PASS: scan3 `2d3b1d7c-0fc2-4669-b7cc-95bc0758d9b2`, scan4 `7a00bbfe-21d8-437c-afe8-1ea781cccb6a`,
  scan5 `3d8be6a6-c019-463e-9a2f-7a33ffce8630`
