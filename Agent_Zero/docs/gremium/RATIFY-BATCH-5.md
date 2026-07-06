RATIFY: GO-WITH-CONDITIONS

# Schnellratifizierung Batch 5 — Faktensheet + Reality-Check-Gateway

Adversarialer Review von `PROMPT-BATCH-5.md` gegen den Ist-Code (`brain/`,
`docs/AGENCY_BRAIN_SCAN_SKILL.md`) und den kontaminierten Live-Task
`proj-zurich-circle-hublcr` in `tasks.json`. Grundrichtung tragfähig, lean,
mit eigener Anti-Overengineering-Sektion. Freigabe unter den folgenden Auflagen.

## Diagnose am Live-Bestand bestätigt (Design trifft die richtigen Ursachen)
- Fabrizierte Links real vorhanden: `src-7ab6764a`→`turn1search8`,
  `src-98d9ffd3`→`turn1search112`, `src-6d2675a9` UND `src-zones-aug-1783`→
  BEIDE `turn1search11` (zwei Refs, identisches Fabrikat). Ist-Guard
  (`invalidSourceLinkReason`) prüft nur Syntax → Fabrikate passieren. Sie stehen
  zusätzlich in `additionalLinks[]`. Punkt 5 (Deny-Pattern `turn\d+search\d+`)
  trifft das exakt. ✓
- Durchmischung real: `pmStatus.current`/`risks`/`waitingOn` + LineItems
  `li-circle-timeline`/`li-circle-zones-handover` verweben Moerken-Content;
  Brain schrieb „flagged for review" und verwob trotzdem. factSheet (1/2) +
  Checkliste C (3) + Gateway (4) adressieren das strukturell. ✓
- Root-Cause 3 (kein Realitäts-Kontext, keine unabhängige Prüfung vor Apply):
  factSheet-in-State + Gateway schließen das. ✓

## Blockierende Auflagen (vor Merge zu erfüllen)
1. LINK-GUARD DENY-FIRST: Die Whitelist „outlook.office*.com …/mail …id-Pfad"
   deckt das Fabrikat `outlook.office.com/mail/inbox/id/turn1search112` selbst
   ab. Deny-Pattern MUSS Vorrang vor der Whitelist haben (erst Deny prüfen, dann
   Whitelist). Sonst lässt die Whitelist genau das Fabrikat wieder durch.
2. FREITEXT-SCAN (das verbleibende Loch für Links in pmStatus): Der Guard prüft
   nur `sourceRef.link`. Eine fabrizierte URL in `pmStatus.current`, in
   Listen-`text`, in LineItem-Feldern (`currentState`/`problem`/…), `evidenceText`
   oder `summary` bleibt unentdeckt und landet in pmStatus. Guard MUSS dieselben
   Token-Muster auch in allen Freitextfeldern strippen/flaggen.
3. GATEWAY-AUSFALL WIRKLICH FAIL-CLOSED: „nur Marker mit bestehender sicherer
   Referenz anwenden" schützt NICHT gegen Durchmischung — `evaluateEvidence`
   akzeptiert eine existierende Ref auch mit `link=null`, ein Kontaminations-
   `PROJECT_UPDATE`/pmStatus-Marker hätte also eine „sichere Referenz" und würde
   bei Gateway-Ausfall angewandt. Bei Ausfall MÜSSEN alle durchmischungsfähigen
   Marker (PROJECT_UPDATE/pmStatus-Mutationen, LINEITEM_NEW/UPDATE an bestehende
   Projekte, Cross-Projekt-Zuordnungen) auf needs-review; auto-apply nur für
   nicht-intermixing-fähige Marker (eigenständige TASK_NEW, NEEDS_REVIEW,
   SCAN_DONE).
4. GATEWAY-PARSING-VERTRAG: fehlendes/unparsbares/ausgelassenes Urteil ⇒
   needs-review (NIE approve); Apply nur bei explizitem `approve`; Urteile strikt
   subtraktiv — der Server konsumiert nur enum+Ein-Satz-Begründung und ignoriert
   jede vom Gateway „korrigierte" Marker-Payload (Gateway darf nie ADD/MUTATE,
   nur filtern). Sonst zweites Fabrikations-Loch über den Prüfer.
5. 6a VERLUSTARM STATT NUR-NULL: additionalLinks trägt die `turn*search*`-
   Fabrikate aktuell noch → nach dem Nullen MUSS `task.link` + `additionalLinks`
   neu abgeleitet werden. Vor dem Nullen bevorzugt echten Link aus dem
   archivierten Ursprungs-Task rekonstruieren (Matching aus
   `repair-source-links.mjs` wiederverwenden); null nur wenn kein echter Link
   wiederherstellbar. Design „Fabrikate auf null" allein verwirft
   rekonstruierbare Echt-Links.
6. 6b REFERENZIELL INTEGER + REVERSIBEL: entfernte Kontaminations-Einträge
   verbatim inkl. Evidenz-Refs in reviewQueue ablegen; zugrunde liegende
   sourceRefs (`src-moerken-20260701`, `src-zones-aug-1783`) NICHT hart löschen;
   LineItem-`evidenceRefIds`, die auf verschobene Quellen zeigen, mitbereinigen
   (keine Dangling-Refs, sonst spätere Marker-Drops). Backup vor Mutation.

## Einwände / nicht-blockierende Auflagen
7. Anforderung A ist Code-Änderung: `COPILOT_EFFORT` ist heute hart `'high'`.
   Default `xhigh` + env `AGENT_ZERO_BRAIN_EFFORT`, `long_context`, `opus-4.8` —
   für Primär- UND Gateway-Run. (xhigh ist für opus-4.8 gültig, kein Blocker.)
8. KORRELIERTES VERSAGEN benennen: Gateway = gleiches Modell, gleiche factSheets,
   0 workiq. Es fängt factSheet-Widerspruch, Token-Links und done+wartet-
   Inkonsistenz, kann aber eine ECHTE-aber-falsches-Projekt-Zuordnung ohne
   unterscheidendes factSheet-Faktum NICHT unabhängig verifizieren. Gateway-
   Prompt adversarial (Default-Reject bei Land/Standort/Org-Mismatch), und ihm
   NICHT die Primär-Narrative geben (Anchoring vermeiden). Deterministische
   Layer bleiben die harte Garantie; der Gateway ist Verbesserung, kein Orakel.
9. Gateway muss die VOLLEN factSheets erhalten (Spill/Pflicht-Read), nicht das
   auf 24 KB gekürzte State-Doc — sonst prüft er gegen unvollständige Realität.
   Ebenso: factSheet-Vollrender darf den Primärlauf nicht still auf Truncation
   drücken (Nutzerforderung „100% Überblick").
10. Losslessness: nicht-deny, aber nicht-whitelisted (ungewöhnlich geformte)
    ECHT-Links KEEPEN + flaggen, nicht auto-nullen. „nicht-whitelisted ⇒
    link=null" ist verlustbehaftet und widerspricht der Verlustfreiheits-Prämisse.
11. Whitelist muss die realen Formen abdecken: `outlook.office365.com/owa/?ItemID=`,
    `teams.microsoft.com/l/message/`, sowie bare `outlook.office365.com/owa/`
    (real bei `src-32f0c7ee`) — sonst nullt 6a legitime Links.
12. NEEDS_REVIEW und SCAN_DONE vom Gateway-Veto ausnehmen (Sicherheits-/Status-
    Marker dürfen nicht „reject"-bar sein).
13. Tests: B-7…B-10 ok. Ergänzen: B-11 Freitext-Fabrikat (Token in
    `pmStatus.current` ⇒ gestrippt), B-12 Gateway-Ausfall (PROJECT_UPDATE mit
    existierender Ref + Kontamination ⇒ needs-review, NICHT applied), B-13
    Gateway-lässt-Urteil-aus ⇒ needs-review, B-14 echter Ungewöhnlich-Link bleibt
    erhalten. Plus Regressions-Fixture aus echten Circle-Daten (ein Fabrikat von
    zwei Refs geteilt: `turn1search11`).

## Übermäßiges? Nein.
Kein Vektor-Store/DB/Subagenten-Schwarm/UI-Umbau (explizit ausgeschlossen).
Einziger echter Kosten-/Latenz-Zuwachs: zweiter voller opus-4.8/xhigh/long_context-
Run pro Scan (Gateway). Bei 2 Scans/Tag vertretbar und als zentrale Kontrolle
gerechtfertigt. premiumRequests weiter loggen (bereits vorhanden).

## Fazit
Alle 3 Diagnose-Ursachen werden strukturell geschlossen; das Layering
(deterministischer Guard → Checkliste C → Gateway) ist der richtige Ansatz, weil
reine Prompt-Kontrolle (C) nachweislich nicht reicht (Brain hatte bereits eine
NEEDS_REVIEW-Regel und kontaminierte trotzdem). Freigabe unter den 6 blockierenden
Auflagen; die zentralen Restlöcher sind #2 (Freitext-Links) und #3 (Gateway-
Ausfall gegen Durchmischung nicht fail-closed). Nach deren Umsetzung ist das
Design belastbar.
