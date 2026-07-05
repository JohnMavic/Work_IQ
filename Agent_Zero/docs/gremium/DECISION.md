# Gremium-Adjudikation: verbindliche Entscheidungen (Master, 2026-07-05)

Basis: RESULT-CODEX-PLAN.md + RESULT-AGENCY-PLAN.md. Konsenspunkte gelten unverändert
(ein globaler Brain-Run pro Scan; keine `--resume`-Sessions; Batch-only-Marker fail-closed
ohne Coercion in v1; additives v5-Schema in tasks.json; atomare Writes; Flag-gated mit
Legacy-Fallback; Evidenz-Pflicht; kein Learning-Wiki/Stream-Ledger/DB/Framework;
days/scanDays-Bug-Fix). Nachfolgend die Streitpunkte mit Entscheid.

## D1 Datenmodell: Projekt = Task (Codex), NICHT separates projects[]-Array (agency)
**Entscheid: Codex.** `taskType:"project"` mit `lineItems[]` + `pmStatus` + `sourceRefs[]`.
Ursprungs-Tasks werden via `archived:true`/`supersededBy` erhalten (nie gelöscht) —
das erfüllt agencys berechtigte Verlustfreiheits-/Umkehrbarkeits-Forderung (R7) ohne
zweite Entität. Begründung: Der Nutzer denkt in «EIN Task mit Line Items»; die bestehende
SPA (Karten, Statusfilter, Detailpanel, Log/Notes) funktioniert unverändert für
Projekt-Tasks. Undo = archived/supersededBy zurücksetzen + Projekt-Task entfernen.
**Übernahme aus agency:** pmStatus-Einträge sind STRUKTURIERT, nicht Freitext-Arrays:
`{text, date?, evidence?, confidence?}` je Eintrag in planned/userActions/problems/
risks/waitingOn — maschinell prüfbar (G3-Abnahme).

## D2 Discovery: Brain macht Discovery selbst (Codex), KEINE persistente Signal-Inbox (agency)
**Entscheid: Codex.** Der Brain fragt WorkIQ selbst (geerbtes MCP-Tool `ask`) und
konsolidiert im selben Run. Die Regex-Parser (parseMarkdownEmails etc.) und die
hartkodierten NL-Queries entfallen im Agency-Pfad. Agencys Auditierbarkeits-Anliegen
deckt `sourceRefs[]` ab (jedes Signal wird als SourceRef mit Link/Datum persistiert).
Eine zweite Store-Entität `signals[]` wäre Overengineering für 2 Scans/Tag.

## D3 Marker-Set: Codex-Grammatik, minus ASK_USER, plus NEEDS_REVIEW (agency)
**Entscheid: Hybrid.**
`[PROJECT_NEW]`, `[PROJECT_UPDATE]`, `[LINEITEM_NEW]`, `[LINEITEM_UPDATE]`,
`[TASK_NEW]`, `[TASK_UPDATE]`, `[NEEDS_REVIEW]`, `[SCAN_DONE]`.
ASK_USER entfällt (blockierender Interaktions-Kanal passt nicht zu scheduled scans);
NEEDS_REVIEW ist die nicht-blockierende Alternative: Low-Confidence-Zuordnungen werden
NICHT angewandt, sondern als Review-Eintrag persistiert und in der UI gebadged.
Evidenz-Gate (agency R4): Status-ändernde Marker ohne Evidence-Ref (Link ODER Datum,
existierend oder in derselben Batch eingeführt) werden gedroppt + Audit-Log.

## D4 --max-autopilot-continues = 0 (Codex/TZ03), agencys R9 wird im Loop empirisch geprüft
**Entscheid: 0 in v1.** Continuation-Turns riskieren doppelte/widersprüchliche Marker im
aggregierten Batch-Text und kosten Premium-Requests. Wenn die Verifikations-Loop zeigt,
dass Runs vor SCAN_DONE abbrechen (agencys R9), wird auf 1–2 erhöht + Marker-Dedup
nachgerüstet. Messpunkt: SCAN_DONE-Quote über die Testläufe.

## D5 Sandbox: --add-dir NUR auf dediziertes Brain-Arbeitsverzeichnis
**Entscheid: Master-Auflage (in beiden Plänen zu lasch).** Der Brain bekommt
`--add-dir E:\Work_IQ\Agent_Zero\brain-work` (dediziert; enthält State-Dokument +
ggf. Spill-Dateien), NICHT den App-Root. Der Brain darf tasks.json physisch nicht
erreichen — «Brain schreibt nie State» wird damit erzwungen, nicht nur versprochen.
cwd = brain-work. tasks.json/server.js bleiben außerhalb der Whitelist.

## D6 Projekt-Granularität: Nutzer-Mentalmodell ist bindend
**Entscheid: Master-Klarstellung (agency lag hier falsch).** Der Seestrasse-Umbau ist
EIN Projekt mit AV/LAN/CHD/Patch-Panel/Switch-Ports als LINE ITEMS — nicht mehrere
Projekte (so hat es der Nutzer explizit definiert). Der Brain-Prompt definiert Projekt
als «reales Vorhaben, wie der Nutzer es denkt (typisch Ort+Zweck, z.B. ein Umbau,
eine Beschaffung, eine Migration)»; Teilthemen desselben Vorhabens sind Line Items.
Agencys Übermerging-Warnung (R5) bleibt gültig für ECHTE Fremd-Themen (z.B. anderes
Gebäude, unabhängiger Incident): 1 Signal → max. 1 Projekt; unsicher → NEEDS_REVIEW.

## D7 Slice 0 als hartes Gate (agency)
**Entscheid: übernommen.** Headless-Probe: workiq in session.mcp_servers_loaded + echte
Antwort + exit 0, sonst STOP (Legacy bleibt). Läuft bereits.

## D8 Migration: Dry-Run-Preview wird vom Gremium adversarial geprüft, nicht von Martin blockiert
**Entscheid: Hybrid.** Codex' Slice 8 (Brain-getriebene Bestandskonsolidierung mit
Dry-Run-Preview) + agencys Invarianten-Tests (Σ History-Einträge und Σ Links vor/nach
identisch; nichts gelöscht). Der Preview wird von agency copilot gegen die
Seestrasse-Grundwahrheit verifiziert (Auditor-Rolle), bevor Apply läuft. Preview-Datei
bleibt für Martin einsehbar.

## D9 Slice-Reihenfolge: Codex' 10 Slices, ergänzt um Slice 0
0. GO/NO-GO-Gate (läuft) → 1. Brain-Runner-Skeleton → 2. saveAtomic + v5-Migration →
3. Marker-Parser/Applier → 4. Brain-Prompt + State-Renderer → 5. Brain-Scan hinter Flag →
6. Scheduler/Job-Umschaltung → 7. UI Projekt-Tasks → 8. Bestandskonsolidierung
(Dry-Run→Audit→Apply) → 9. SDK/WorkIQ-0.2.8-Entfernung → 10. Live-Verifikation.
Slice 9 erst NACH stabiler Live-Verifikation (Codex' Kurzempfehlung §11).

## D10 Betriebsparameter v1
Modell `claude-opus-4.8` gepinnt (argv-Front + COPILOT_MODEL), `--effort high`,
`--context long_context`, `--no-default-mcps` (agency-eigene MCPs aus; geerbtes
mcp-config-workiq bleibt), `--disable-mcp-server playwright` u.ä., Timeout 25 min,
Salvage ≥200 B, WorkIQ-Call-Soft-Budget 10 (Prompt) / Hard-Kill 25 (Orchestrator zählt
tool.execution_start), usage.premiumRequests wird pro Run in jobs.json geloggt.
