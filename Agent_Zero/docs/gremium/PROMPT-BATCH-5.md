# Batch 5: Faktensheet + Reality-Check-Gateway (Nutzer-Eskalation 2026-07-06)

## Diagnose (Master, am Live-Datenbestand belegt)
1. FABRIZIERTE LINKS: Brain wandelt WorkIQ-Zitations-Tokens in Pseudo-URLs
   (`https://outlook.office.com/mail/inbox/id/turn1search112`). Link-Guard prüft nur
   Syntax → Fabrikate passieren.
2. PROJEKT-DURCHMISCHUNG: «Zurich The Circle»-pmStatus enthält Christian Moerkens
   NORWEGEN-Projekt (30.6./1.7.-Mails, MPR-Themenähnlichkeit). Brain bemerkte den
   Datumskonflikt sogar («flagged for review»), verwob die Story aber trotzdem.
3. Ursache beider: State-Doc enthält keinen Realitäts-Kontext pro Projekt
   (Ort/Scope/Beteiligte/Entscheidungen) und es gibt keine unabhängige Prüfung vor Apply.

## Bindende Nutzer-Anforderungen (wörtlich umzusetzen)
A. Agency-Aufrufe: Modell claude-opus-4.8, `--context long_context`, Reasoning
   MINDESTENS Extended Thinking → `--effort xhigh` als neuer Default für Brain-Runs
   (konfigurierbar via env AGENT_ZERO_BRAIN_EFFORT).
B. FAKTENSHEET pro Projekt-Task (und sinngemäß kompakt pro Single-Task): lebendes,
   bei jedem Scan erweitertes/korrigiertes Dokument mit mindestens: Um was geht es ·
   Scope · Ziele · Timeline · Budget · Kosten · Approvals · Chancen · Schwierigkeiten ·
   Herausforderungen · Status · Beteiligte (mit Kontaktdaten soweit aus Mails bekannt,
   Rolle, Organisation, LAND/STANDORT) · Entscheider · getroffene Entscheidungen ·
   offene Aufgaben. Struktur erweiterbar.
C. Zuordnungs-Checkliste — VOR jeder Verarbeitung einer neuen Information MUSS geprüft
   und (bei Unsicherheit) mit NEEDS_REVIEW beantwortet werden:
   - Zu welchem Task/Projekt kann ich diese Info SICHER zuordnen?
   - Neu oder veraltet (vs. Faktensheet + lastEvidenceAt)?
   - Muss das Projekt aktualisiert werden? (Nicht-Aktualisieren ist genauso falsch!)
   - Enthält das Faktensheet Fehler, die diese Info korrigiert?
   - Wirklich DIESES Projekt — oder ein ähnliches in anderem Land/Standort/Org?
   - Ist der App-Nutzer (Martin) überhaupt beteiligt?
   - Ist das Ergebnis konsistent? (z.B. nicht «abgeschlossen» UND «wartet auf Lieferung»)
D. NICHT TOLERIERT (= harte Testkriterien): Durchmischen von Projekten · Zuordnung an
   falsche Projekte · Nicht-Aktualisieren offensichtlich zugehöriger Infos · Erfinden
   von Scheinsituationen/Links.

## Umsetzung (lean, keine neue Infrastruktur)
1. Datenmodell: `task.factSheet` (strukturiertes Objekt mit obigen Sektionen, je Eintrag
   optional evidence/datum). Neuer Marker `[FACTSHEET_UPDATE] {taskId, sectionPatches}`
   (additiv/korrigierend, fail-closed validiert; Löschungen nur mit Begründung+Evidenz).
2. Renderer: Faktensheet JEDES offenen Projekts VOLLSTÄNDIG ins State-Doc (bzw. Spill
   mit Pflicht-Read) — das Brain hat die Projektrealität IMMER im Kontext (Nutzer-
   forderung «100% Überblick»).
3. Prompt-Rewrite (AGENCY_BRAIN_SCAN_SKILL.md): Checkliste C wörtlich als Pflichtschritt
   pro Information; Links NIEMALS konstruieren — nur verbatim aus WorkIQ-Antworten
   kopieren, sonst weglassen (link=null); Widerspruch erkannt ⇒ NEEDS_REVIEW statt
   Erzählung; Land/Standort/Organisations-Abgleich explizit.
4. REALITY-CHECK-GATEWAY (Kern): Nach dem Scan-Run, VOR dem Apply, prüft ein ZWEITER,
   frischer agency-Run (gleiche Modellparameter, eigener Kontext) die vorgeschlagene
   Marker-Batch gegen die Faktensheets + State-Doc: pro Marker Urteil
   approve/reject/needs-review mit Ein-Satz-Begründung (strukturierte Antwort, vom
   Server fail-closed geparst; bei Gateway-Ausfall: NUR Marker mit bestehender
   sicherer Referenz anwenden, Rest needs-review). Geprüft wird genau Checkliste C + D
   + Link-Echtheit + Konsistenz. Server wendet nur approved an; rejected/review landen
   in reviewQueue mit Begründung.
5. Deterministischer Link-Guard (zusätzlich, vor Gateway): Reject-Pattern
   `turn\d+search\d+` u.ä. Token-Muster; Whitelist-Formen für Outlook/Teams-Deep-Links
   (outlook.office*.com/owa|/mail mit item-id-artigem Pfad, teams.microsoft.com/l/…);
   nicht-whitelisted ⇒ link=null + Audit (Quelle ehrlich als fehlend zeigen).
6. Datenreparatur JETZT: (a) alle sourceRefs/Evidence-Links gegen 5 prüfen — Fabrikate
   auf null + Audit; (b) The-Circle-Projekt: kontaminierte pmStatus/lineItem-Einträge
   (Moerken/Norwegen) entfernen und als reviewQueue-Einträge ablegen; (c) einmaliger
   Faktensheet-Bootstrap-Run über alle offenen Projekte (mit Gateway!) aus archivierten
   Ursprungs-Tasks + WorkIQ.
7. Tests: Unit (Marker/Guard/Gateway-Parsing, Fabrikat-Links, factSheet-Merge) +
   Serie-B-Fixtures NEU: B-7 Kontaminations-Fixture (ähnliches Projekt, anderes Land,
   ähnliche Begriffe ⇒ MUSS getrennt bleiben/NEEDS_REVIEW), B-8 Link-Echtheit
   (Zitations-Token ⇒ null), B-9 Konsistenz (done+wartet ⇒ NEEDS_REVIEW), B-10
   Pflicht-Update (Info gehört offensichtlich zu Projekt ⇒ MUSS als Update erscheinen,
   Nicht-Anwenden = FAIL).
8. Kosten: Gateway-Run zusätzlich pro Scan (klein: nur Marker+Faktensheets als Input,
   Budget 0 workiq-Calls default, 5 min Timeout). premiumRequests weiter loggen.

## Amendment (Nutzer, 2026-07-06 — bindend)
M1. FAKTENSHEET-SICHTBARKEIT: factSheet bleibt als strukturiertes Objekt in tasks.json
    (Quelle der Wahrheit, maschinenlesbar). Für den NUTZER: (a) eigener Tab/Abschnitt
    «Fact Sheet» im Task-Detailpanel der UI, der das Objekt sauber als HTML rendert
    (feste Sektions-Reihenfolge, Evidenz-Links, Datum je Eintrag); (b) zusätzlich
    Export-Endpoint `GET /api/tasks/:id/factsheet.html` → eigenständige, versandfähige
    HTML-Seite (selbsterklärend, druckbar). Agent liest die Struktur via State-Doc,
    Nutzer liest HTML — beide aus derselben Quelle, kein Duplikat-Pflegeaufwand.
M2. EINHEITLICHE STRUKTUR: identische, feste Sektions-Reihenfolge für alle Sheets
    (Overview · Scope & Goals · Timeline & Milestones · Budget & Costs & Approvals ·
    Status · Opportunities · Risks & Challenges · People & Roles (mit Organisation,
    STANDORT/LAND, Kontaktdaten soweit bekannt) · Decision Makers · Decisions Log ·
    Open Actions · Sources). Sheet-Inhalt IMMER ENGLISCH, unabhängig von der Sprache
    des Nutzers/der Quell-Mails.
M3. UI-DATUMSANZEIGE (aus gestopptem Einzel-Task übernommen): Bei ALLEN Quellen-Links
    (Open source, Evidence-Badges, Quellenliste, additionalLinks, Line-Item-Evidenz)
    das Quellendatum als dd.mm.yyyy im Linktext (zentrale Helper-Funktion, defensiv
    bei fehlendem Datum, kein 'Invalid Date'); Render-Test inkl. Fehlt-Fall.

## Zukunfts-Notiz (NICHT in diesem Batch bauen — nur factSheet-Struktur offen halten)
Geplante v2-Quellen für Faktensheets: lokale Ordner (per-Projekt konfigurierbare
Pfade, read-only via --add-dir oder Pre-Staging nach brain-work) und SharePoint
(v1-Weg: workiq-ask deckt SharePoint-Inhalte bereits über den M365-Index ab —
Prompt darf SharePoint-gezielte Fragen stellen; v2: agency Built-in-MCPs sharepoint/
onedrive/graph). factSheet.sources soll deshalb source-Typen email|teams|sharepoint|
file|manual zulassen.

## Anti-Overengineering
Kein Vektor-Store, keine DB, kein separater Subagenten-Schwarm im Server (das
Master-Brain+Gateway-Muster genügt), keine UI-Umbauten außer reviewQueue-Anzeige
falls noch nicht sichtbar.

## Ablauf
Codex implementiert (kleine Commits, npm test grün), führt Reparatur 6a/6b aus,
dann Bootstrap 6c, dann RESULT `docs/gremium/RESULT-BATCH-5.md` Zeile 1
`BATCH5: OK <details>` / `BATCH5: PARTIAL <grund>`. Danach separater Live-Audit
(agency) mit den D-Kriterien am echten Datenbestand inkl. The-Circle-Nachkontrolle.
Sicherheitsregeln: keine STOP/START-Skripte; tasks.json nur via Skripte mit Backup;
Nutzer-Instanz nicht anfassen.
