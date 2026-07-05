VERDICT: GO-WITH-CONDITIONS

# Ratifizierung der Gremium-Adjudikation (Unabhängiger Auditor, 2026-07-05)

**Rolle:** Unabhängiger Auditor · **Basis:** DECISION.md (D1–D10), RESULT-AGENCY-PLAN.md (mein Plan),
RESULT-CODEX-PLAN.md, MISSION.md (G1–G7). Slice-0-Gate live bestanden (workiq in
`mcp_servers_loaded`, echte `ask`-Antwort, exit 0, premiumRequests=15).

**Kurzfassung:** Kein Entscheid erzeugt einen irreversiblen Datenverlust-Pfad (alles non-destruktiv:
`archived` statt Löschung, `.bak`, atomare Writes, Σ-Invarianten-Test, Auditor-Gate). Keiner ist ein
G1–G7-Killer, der nicht durch das Slice-0-Gate + strikten Erfolgsbegriff + Verifikations-Loop gefangen
würde. Die vier Überstimmungen (D1, D2, D4, D6) sind vertretbar und in mehreren Fällen **sicherer** als
meine Originale. Meine sicherheitsrelevanten Kerninhalte (Evidenz-Gate R4, Übermerge-Guard R5,
non-destruktive Migration R7, NEEDS_REVIEW, Slice-0-Gate) sind erhalten. Ich blockiere nicht. Es
bleiben **zwei bindende Auflagen** (A1, A2), die den Build vor Verschwendung / Fehlverifikation
bewahren, plus vier empfehlende Auflagen. Daher **GO-WITH-CONDITIONS**, keine Re-Adjudikation nötig.

---

## Urteile je Entscheid

### D1 — Projekt = Task (Codex) statt separates `projects[]` (agency): **ACCEPT**
Meine zwei sicherheitskritischen Forderungen sind erhalten: (1) non-destruktive Bewahrung der
Ursprungs-Tasks via `archived:true`/`supersededBy` (nie gelöscht) — erfüllt R7; (2) `pmStatus`-Einträge
STRUKTURIERT `{text, date?, evidence?, confidence?}` — erhält mein maschinenprüfbares Evidenz-Gate für
G3/R4. Das separate Entity war Implementierungs-Präferenz, keine Sicherheitsanforderung. Undo
(un-archive + Projekt-Task entfernen) ist äquivalent zu meinem „Unlink → Task standalone". Kein harter
Einwand.

### D2 — Brain macht Discovery selbst (Codex), keine `signals[]`-Inbox (agency): **ACCEPT**
Meine Auditierbarkeit ist über `sourceRefs[]` (Link/Datum/evidenceText je Signal) gedeckt. Ein „nicht
zuordenbares" Signal geht nicht verloren: es wird SourceRef, `[TASK_NEW]`-Fallback oder `[NEEDS_REVIEW]`
— nichts wird still gedroppt. Merge von Discovery in den Run ist kostenneutral (weiterhin EIN Run) und
entfernt die spröden Regex-Parser (`parseMarkdownEmails`) — ein Plus. Kein harter Einwand.

### D3 — Codex-Grammatik minus ASK_USER plus NEEDS_REVIEW (agency): **ACCEPT (mit weicher Auflage A3)**
Übernimmt mein NEEDS_REVIEW + Evidenz-Gate direkt. ASK_USER-Streichung ist korrekt: ein 07:00-Scan
kann nicht blockierend auf Nutzereingabe warten; NEEDS_REVIEW (non-blocking, gebadged) ist strikt
besser für Autonomie. Da das Design durchgehend non-destruktiv ist, braucht nichts einen blockierenden
Gate. **Weiche Auflage A3:** Das gelockerte Gate „Link ODER Datum" öffnet einen schmalen Halluzinations-
Pfad (Statuswechsel nur mit Datum, ohne verifizierbaren Link). Kein harter Einwand (low-confidence →
Review; non-destruktiv; Worst Case = falscher Line-Item-Status, den ein Mensch korrigiert), aber siehe A3.

### D4 — `--max-autopilot-continues = 0` (Codex/TZ03), R9 empirisch im Loop: **ACCEPT**
Master hat mich hier überstimmt — und liegt richtig. Für einen **Batch-only-Parser** ist 0 die
SICHERERE Wahl: Continuation-Turns re-emittieren Marker auf dem aggregierten Transkript → doppelte/
widersprüchliche Marker → Doppel-Apply. Mein „klein-positiv" hätte erst Marker-Dedup gebraucht, um safe
zu sein — Master defert das korrekt bis zum Nachweis. Wichtig: `continues=0` limitiert **Re-Engagement
nach task_complete**, nicht die Anzahl WorkIQ-Toolcalls INNERHALB des Turns — mein R9-Kern (Run braucht
≥3 Suchen) ist damit weitgehend entschärft. Slice-0 hat mit premiumRequests=15 bewiesen, dass ein
realer Run mit echter Arbeit unter diesem Regime terminiert. Escalation-Pfad (→1–2 + Dedup bei
niedriger SCAN_DONE-Quote) ist erhalten. Kein harter Einwand.

### D5 — `--add-dir` nur auf dediziertes `brain-work` (Master-Auflage): **ACCEPT (mit weicher Auflage A4)**
Härtung beider Pläne, schließt ein reales Loch: unter `--yolo`/`--allow-all-tools` hätte `--add-dir
<app-root>` dem Brain erlaubt, `tasks.json`/`server.js` **direkt** zu schreiben und den
Marker→Applier→Atomic-Write-Pfad zu umgehen. Master's Restriktion erzwingt „Orchestrator ist einziger
State-Owner" physisch statt per Versprechen. **Weiche Auflage A4:** Mein R3-Mitigation (Brain liest
Voll-Historien on-demand aus App-Dir) entfällt damit — alles muss der Server kuratiert nach `brain-work`
rendern (State-Doc + gezielte Spill-Dateien für Voll-Historien). Das ist sogar sauberer (kuratierte
Informations-Diät), verlagert aber R3-Budgetdruck auf den Renderer. Kein harter Einwand.

### D6 — Nutzer-Mentalmodell bindend; Seestrasse = EIN Projekt mit Line Items (Master, agency lag falsch): **ACCEPT (mit bindender Auflage A2)**
Hier hat Master meinen zentralen Befund überstimmt — und die Begründung hält stand. Mein Fehler:
Ich habe **Workstream-Grenze** mit **Projekt-Grenze** verwechselt. AV-Refresh und LAN-Verkabelung sind
technisch getrennte Workstreams, aber der Nutzer erlebt sie als „mein Seestrasse-Projekt" (EIN Umbau,
EIN Büro). Das Mentalmodell ist laut MISSION das Produkt. Entscheidend: Master hat den
**Sicherheitsgehalt** meines R5-Einwands bewahrt — „Übermerge-Warnung bleibt gültig für ECHTE
Fremd-Themen (anderes Gebäude, unabhängiger Incident): 1 Signal → max. 1 Projekt; unsicher →
NEEDS_REVIEW." Damit ist mein Schadens-Szenario (ein unabhängiger, dringender Incident wird in einem
großen Umbau-Projekt begraben → Nutzer übersieht ihn) weiterhin abgewehrt.

*Kein harter Einwand*, ABER ein konkretes Fehlverifikations-Szenario zwingt zu Auflage A2: Meine
G5/G2-Abnahmetests (RESULT-AGENCY-PLAN §4) fordern aktuell „trennt AV/MTR **von** LAN-Verkabelung" —
das ist die PRE-D6-Erwartung. Unter D6 sind AV+LAN dasselbe Projekt (Line Items). Ließe man die Tests
unverändert, würden sie ein **korrektes** D6-Ergebnis fälschlich durchfallen lassen bzw. ein falsches
belohnen. Die Tests müssen umgeschrieben werden (A2), sonst verifizieren wir genau das Falsche.

### D7 — Slice 0 als hartes Gate (agency): **ACCEPT**
Meine eigene Empfehlung, verbatim übernommen und bereits live bestanden. Kein Einwand.

### D8 — Migration: Dry-Run-Preview adversarial vom Gremium geprüft (Hybrid): **ACCEPT**
Kombiniert Codex' Brain-getriebene Konsolidierung mit meinen Σ-Invarianten-Tests (Σ History, Σ Links
vor/nach identisch; nichts gelöscht — R7) und ergänzt einen Auditor-Gate (ich) vor Apply. Strikt
sicherer als jeder Einzelplan. Kein harter Einwand. Implizit bindend: der Σ-Invarianten-Test ist ein
HARTER Gate — Apply blockiert, falls Σ History oder Σ Links sinkt.

### D9 — Codex' 10 Slices + Slice 0: **ACCEPT (mit bindender Auflage A5-Sequencing)**
Reihenfolge grundsätzlich tragfähig. Ein Sequencing-Hazard: Konsolidierung der 76 Bestands-Tasks
(Slice 8) kommt NACH Scheduler-Umschaltung (Slice 6). Würde der Engine-Flag
(`AGENT_ZERO_SCAN_ENGINE=agency`) vor Slice-8-Apply geflippt, führte der erste geplante Agency-Scan
eine **un-auditierte Massen-Konsolidierung** durch (umgeht das D8-Auditor-Gate). *Kein harter Einwand*
(non-destruktiv + `.bak` + reversibel), aber die Flag-Sequenz muss explizit sein → Auflage A5.

### D10 — Betriebsparameter v1: **ACCEPT (mit bindender Auflage A1 + empfehlender A6)**
Modell-Pin (argv-Front + `COPILOT_MODEL`) deckt R13. Orchestrator-erzwungenes WorkIQ-Budget (soft 10 /
hard-kill 25 via `tool.execution_start`) deckt R2 — enforced, nicht nur geprompted. premiumRequests-Log
deckt Kostenüberwachung. Timeout 25 min / Salvage ≥200 B in Ordnung.
**Bindende Auflage A1 (Angelpunkt von G1):** `--no-default-mcps` war NICHT Teil meines bestandenen
Slice-0-Probes (RESULT-AGENCY-PLAN.md:132 lief ohne dieses Flag). D10/Codex verlässt sich aber darauf,
dass die geerbte `~/.copilot/mcp-config.json`-WorkIQ `--no-default-mcps` **überlebt**. Falls
„default mcps" die User-Config-MCPs einschließt, dropt das Flag WorkIQ → Brain ohne Discovery → leere/
Müll-Konsolidierung. Das ist plausibel gutartig gefangen (strikter Erfolg + workiq-Toolcall-Assertion),
aber verschwendet einen Build-Zyklus + Premium-Requests → A1. **Empfehlende Auflage A6:** Hard-Kill 25
WorkIQ-Calls kann für den EINMALIGEN Slice-8-Migrationslauf (76 Tasks, mehrere Projekte) zu niedrig
sein; für diesen Sonderlauf höheres Budget erlauben, für inkrementelle 2×/Tag-Scans bleibt 10–25 reichlich.

---

## Auflagen

### Bindend (müssen vor Abhängigkeit erfüllt sein — keine Re-Adjudikation nötig)

**A1 (G1-Angelpunkt, vor Slice 1/5):** Slice-0-Probe mit der EXAKTEN D10-Flag-Kombination wiederholen
(`--no-default-mcps --disable-mcp-server playwright …`) und assertieren, dass `workiq` weiterhin in
`session.mcp_servers_loaded` erscheint **und** eine echte Antwort kommt. Erst wenn grün, darf der reale
Runner auf `--no-default-mcps` bauen. Billig (ein Probe-Run), schließt die Lücke zwischen dem, was
Slice 0 bewiesen hat (Default-Flags), und dem, was D10 laufen lässt.

**A2 (G5/G2-Fehlverifikation, vor Slice 8/Abnahme):** Die G5/G2-Abnahmetests (RESULT-AGENCY-PLAN §4)
an D6 anpassen: AV + LAN + Patch-Panel + Switch-Ports werden als Line Items EINES Seestrasse-Projekts
ERWARTET (nicht als getrennte Projekte); nur genuine Fremd-Themen am selben Ort (unabhängiger Incident,
anderes Gebäude) müssen getrennt bleiben. Sonst kodieren die Tests die Pre-D6-Erwartung und benoten das
zu verifizierende Verhalten falsch. Der Seestrasse-Report bleibt ausschließlich menschliche Messlatte —
keine Strings einkodieren.

### Empfehlend (Härtung, nicht blockierend)

**A3 (D3-Evidenz-Gate):** Wo nur ein Datum (kein Link) als Evidenz vorliegt, `confidence` auf ≤ medium
zwingen (surfacet für Review) UND das Datum muss auf eine im selben Run erfasste SourceRef zurückführen
— kein bloß modell-emittiertes Datum. Hält das Anti-Halluzinations-Gate bedeutsam.

**A4 (D5-Kontext-Budget/R3):** Der State-Renderer schreibt State-Doc UND alle nötigen
Voll-Historie-Spill-Dateien nach `brain-work` (kuratierte Diät statt on-demand-Reads). `brain-work` pro
Run vom Server anlegen/leeren (keine Stale-Cross-Run-Leckage), in `.gitignore`, und aus der
path-restringierten Prozess-Cleanup-Logik ausnehmen (Single-Instance-Regeln unberührt).

**A5 (D9-Sequencing):** Engine-Default bleibt `legacy`, bis Slice-8-Apply auditiert abgeschlossen ist;
Flip auf `agency` erst in Slice 10. Kein geplanter Agency-Scan vor auditierter Bestands-Konsolidierung
(sonst un-auditierte Bulk-Merge — reversibel, aber umgeht das D8-Gate).

**A6 (D10-Budget):** Für den einmaligen Slice-8-Migrationslauf höheres WorkIQ-Hard-Kill-Budget erlauben
als die inkrementellen 25; premiumRequests dieses Sonderlaufs separat loggen/beobachten.

---

## Warum GO-WITH-CONDITIONS statt NO-GO
Es gibt **keinen** irreversiblen Schadenspfad und **keinen** G-Killer, der nicht durch das Slice-0-Gate,
den strikten Erfolgsbegriff oder die Verifikations-Loop gefangen wird. Die zwei bindenden Auflagen sind
kein Design-Streit, sondern (A1) eine unverifizierte Flag-Annahme am G1-Angelpunkt und (A2) ein
Testspec, der die Post-D6-Wahrheit noch nicht abbildet — beide billig zu schließen, ohne den Entscheid
zu ändern. Der Plan ist sicher, reversibel, G1–G7-dienlich und frei von Overengineering
(Anti-OE-Liste + D10-Budget-Deckel greifen). **Ratifiziert unter Auflagen A1–A6.**

*Ende des Auditor-Urteils.*
