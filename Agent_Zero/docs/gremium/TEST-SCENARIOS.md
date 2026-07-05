# Testszenarien Agent Zero v5 (Agency-Brain) — Abnahmeprogramm

Stand: 2026-07-05 · Gilt für Ziele G1–G7 (MISSION.md) · A2-konform (D6-Granularität:
AV+LAN+Patch-Panel+Switch-Ports = Line Items EINES Seestrasse-Projekts).

**Grundregel:** Serie A/B prüft generische Invarianten mit synthetischen Fixtures
(automatisiert). Serie C ist die Live-Abnahme; die Seestrasse-Grundwahrheit
(`seestrasse-status-report.html`, READ-ONLY in Task Zero 03) ist ausschließlich
Verifikations-Messlatte — keine Strings daraus in App-Code, Prompts oder Test-Asserts.
Dieses Dokument ist Prozess-Doku; der Brain sieht es nie (D5-Sandbox).

## Serie A — Hermetische Unit-Tests (pro Slice, von Codex geliefert)
- A-1 Runner: exit0+Text=success · exit0+leer=fail · Timeout≥200B=salvaged ·
  exit≠0+0B/0B-residual=silentFailure · Banner-Fixture→residual=0 · Hard-Kill bei 25 Tool-Calls
- A-2 Migration: v4→v5 additiv, idempotent, kein Feldverlust, Task-Anzahl konstant,
  .bak erzeugt, alle Writes atomar
- A-3 Marker: Fence ignoriert · unbekannte Referenz→Drop+Audit · Statuswechsel ohne
  Evidenz→Drop · Datum-only-Evidenz→confidence≤medium+SourceRef-Rückführung (A3) ·
  superseded→archived, nie gelöscht · NEEDS_REVIEW→reviewQueue/brainState ·
  Batch=atomarer Intent (eine Mutation)
- A-4 Renderer: alle offenen Tasks enthalten · Größe<Schwelle bei 76-Task-Fixture ·
  brain-work pro Run geleert (A4) · keine einkodierten Projektfakten

## Serie B — Integration mit Fake-Brain (Slice 5, deterministisch)
- B-1 Fake-Brain-Output (gültige Marker-Batch) → tasks.json korrekt mutiert, ein
  atomarer Write, History-Einträge erzeugt
- B-2 Invalider Output → tasks.json unverändert bis auf Fehler-Log; Job failed sauber
- B-3 Kein SCAN_DONE → outcome=partial, gültige Marker angewandt, Review-Hinweis
- B-4 Konsolidierungs-Fixture: N synthetische Signale (Fantasienamen) über M Vorhaben,
  davon eines mit 2 Workstreams am selben Ort → GENAU M Projekte; die 2 Workstreams
  sind Line Items EINES Projekts (A2!); unabhängiges Thema am selben Ort bleibt separat;
  jedes Signal max. 1 Projekt; kein Signal verloren (SourceRef, TASK_NEW oder NEEDS_REVIEW)
- B-5 Folge-Scan-Fixture: gleiches+neues Signal → Line-Item-UPDATE statt Duplikat;
  zweiter identischer Reconcile erzeugt kein zweites Projekt (Re-Fragmentierungs-Schutz)
- B-6 Σ-Invarianten (D8): Σ History-Einträge und Σ Links vor/nach Konsolidierung
  identisch oder größer; HARTER Gate vor Apply

## Serie C — Live-Abnahme (Seestrasse als Verifikationsfall)

### C-1 Bestandskonsolidierung (nach Slice-8-Apply)
- [ ] Genau EIN aktiver Projekt-Task für den Seestrasse-Umbau (statt der verstreuten
      Zurich/Seestrasse-Einzeltasks)
- [ ] Line Items decken mindestens ab: AV/MTR-Refresh · LAN-Neuverkabelung ·
      Patch-Panel/Kabelraum · CHD-Displays (Switch-Ports/WAN wenn Evidenz vorhanden)
- [ ] Genuine Fremd-Themen (z.B. anderer Raum-/Gebäude-Fall, unabhängige Incidents,
      fremde PO-Approvals) sind NICHT im Projekt-Task
- [ ] Ursprungs-Tasks: archived:true + supersededBy gesetzt, KEINER gelöscht; Σ-Invarianten grün
- [ ] Dry-Run-Preview wurde vor Apply vom Auditor (agency) gegen die Grundwahrheit geprüft

### C-2 PM-Sicht-Qualität (manuell gegen Grundwahrheit, ohne Einkodierung)
- [ ] pmStatus hat alle 6 Sektionen befüllt (current/planned/userActions/problems/risks/waitingOn)
- [ ] Der kritischste Blocker der Grundwahrheit erscheint in userActions/problems (mit Evidenz)
- [ ] Das zentrale Terminrisiko der Grundwahrheit erscheint in risks (mit Evidenz)
- [ ] Wartebedingungen (z.B. Datums-Gates) erscheinen in waitingOn/planned mit Datum
- [ ] Das Ausführungsfenster des zweiten Workstreams (Datumsbereich) ist erfasst
- [ ] JEDE dieser Aussagen trägt einen Evidenz-Ref (Link oder rückführbares Datum)

### C-3 Laufende Aktualisierung (G4) — Kern-Nutzerversprechen
- [ ] Zweiter Live-Scan nach C-1: KEIN neues Seestrasse-Duplikat; neue Signale landen
      als Line-Item-Updates/neue SourceRefs am bestehenden Projekt-Task
- [ ] lastSynthesizedAt/updatedAt aktualisiert; History dokumentiert den Scan-Delta
- [ ] Nicht-Seestrasse-Singles verhalten sich unverändert (keine Zwangs-Projektisierung)

### C-4 Anti-Halluzination (Stichprobe, Auditor)
- [ ] 5 zufällige Status-Aussagen aus dem Projekt-Task werden vom Auditor per
      workiq-ask gegen die Mailbox verifiziert: Aussage durch Quelle gedeckt oder als
      NEEDS_REVIEW/confidence≤medium markiert — keine unbelegte Behauptung als Fakt

### C-5 Robustheit + Kosten (G6/D10)
- [ ] Scan endet mit SCAN_DONE (Quote über ≥3 Läufe beobachten → D4-Messpunkt)
- [ ] Laufzeit < 25 min; premiumRequests + workiqCalls im Job geloggt und ≤ Budget
- [ ] Im Agency-Modus wird KEIN eigener WorkIQ-0.2.8-Subprozess gestartet (ab Slice 9)
- [ ] Legacy-Flag-Rückschaltung (AGENT_ZERO_SCAN_ENGINE=legacy) funktioniert jederzeit

### C-6 UI (G3)
- [ ] Projekt-Karte zeigt Badge + Zahl offener/blockierter Line Items + Nutzer-Aktions-Indikator
- [ ] Detailpanel: 6 PM-Sektionen + Line Items mit Status/Evidenz-Links, auf einem Screen erfassbar
- [ ] Archivierte/superseded Tasks default ausgeblendet, per Toggle sichtbar
- [ ] Alt-Funktionen (CRUD, Notes, Suche, Status-Filter) regressionsfrei (Playwright-Smoke)

## Loop-Protokoll (G-Ziel nicht erfüllt → iterieren)
Pro fehlgeschlagenem Kriterium: (1) Ursache klassifizieren — Prompt / Marker-Validierung /
Renderer-Kontext / WorkIQ-Datenlücke / UI; (2) kleinste Korrektur bauen (Codex);
(3) betroffene Serie erneut; (4) STATE.md fortschreiben. WorkIQ-Datenlücken (z.B.
Teams-Indexierung unvollständig) sind als Umgebungslimit zu dokumentieren, nicht
wegzuoptimieren — der Brain muss die Lücke als offene Frage zeigen statt zu erfinden.
