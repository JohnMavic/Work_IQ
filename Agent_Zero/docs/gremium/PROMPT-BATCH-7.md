# Batch 7: Thread-vollständige Verarbeitung + Action-Item-Gate («Wahrheitsbaum»)

## Nutzer-Eskalation 2026-07-06 (zwei belegte Fehlklassen, im echten Bestand)
FALL A (stale): userAction «Respond to Laith Skeik's unanswered meeting request to walk
through the cabling plan». Realität im Thread «Seestrasse - Cabling works August»:
@-Mention an Martin stammt vom 8. Jun («bist Du am Donnerstag bei der Ortsbegehung
dabei?») — gemeint war der 11. Jun, längst vorbei; der Thread lief danach normal weiter.
FALL B (nie adressiert + aufgelöst): userAction «Review the color-coded AV decommission
asset list (keep vs disposal)». Realität im Thread «Installation date Microsoft Seestr.»:
Frage ging an Patrick Harris (Martin nur CC), Patrick hat am 9. Jun geantwortet
(«I believe it to be correct… Trust that's all OK?») — aufgelöst, nie Martins Aufgabe.

## Root Cause (Master-Diagnose)
Das Brain synthetisiert aus WorkIQ-ANTWORT-SCHNIPSELN (lossy Zusammenfassungen) statt
aus vollständigen Threads. Es fehlen drei Prüfungen, die nur der VOLLE Thread liefern
kann: (1) Adressierung (TO/@-Mention an den Nutzer vs. nur CC), (2) Auflösung (wurde
die Frage SPÄTER im Thread beantwortet/erledigt — von wem?), (3) zeitliche Gültigkeit
(referenzierte Termine in der Vergangenheit?).

## Umsetzung
1. THREAD-VOLLSTÄNDIGE VERARBEITUNG (Kern): Bevor irgendein Action-Item oder
   Status-Update erzeugt/geändert wird, MUSS das Brain den betroffenen Thread
   VOLLSTÄNDIG chronologisch beschaffen und lesen (workiq-ask kann volle
   Thread-Inhalte liefern — Abfrage-Muster: «show the complete thread ‹subject›
   with all messages, dates, From/To/CC, full bodies»; ggf. mehrere Abfragen).
   Scope-Regel gegen Kostenexplosion: Voll-Thread-Pflicht NUR für Threads, aus denen
   ein neues/geändertes Item entstehen soll — reine Kenntnisnahme braucht keinen
   Voll-Abruf. workiq-Budget pro Scan entsprechend anheben (Soft 20/Hard 40).
2. ACTION-ITEM-GATE (hart, dreistufig — Prompt UND Reality-Gateway prüfen BEIDE):
   Eine userAction (owner=user) darf NUR existieren wenn:
   a) EXPLIZITE ADRESSIERUNG: Der Nutzer ist in TO oder per @-Mention/namentlich
      direkt aufgefordert — mit VERBATIM-ZITAT (Satz + Absender + Datum) als Pflicht-
      Evidenzfeld `askQuote {text, from, date}` am Action-Eintrag.
   b) UNAUFGELÖST: Alle SPÄTEREN Nachrichten des Threads wurden geprüft; keine
      Antwort/Erledigung gefunden. Falls von jemand anderem aufgelöst → KEINE Action
      (ggf. Faktensheet-Update «resolved by X on date» mit Zitat).
   c) ZEITLICH GÜLTIG: Referenzierte Termine liegen nicht in der Vergangenheit;
      vergangenes Datum ⇒ Action obsolet — nur wenn Evidenz zeigt, dass das Thema
      weiterhin offen ist, darf eine NEU formulierte Follow-up-Action mit aktueller
      Begründung entstehen.
   Analog für Fremd-Owner-Actions in lineItems/factSheet (askQuote + resolved-Check).
   Gateway erhält für jede vorgeschlagene Action den Voll-Thread-Auszug (oder die
   askQuote+Auflösungs-Prüfspur) und verifiziert a-c einzeln; fehlt die Prüfspur ⇒ reject.
3. WAHRHEITSBAUM-BUCHFÜHRUNG: factSheet 'Open Actions'/Line Items erhalten je Eintrag
   `threadRef` (Subject/Konversations-Anker), `lastVerifiedMessageDate` und
   `resolutionStatus (open|resolved|obsolete)`. Jeder Scan prüft NEUE Nachrichten
   eines bekannten Threads gegen die bestehenden Einträge dieses Threads (Punkt für
   Punkt: geändert? erledigt? wer muss was tun?) statt neue Parallel-Wahrheiten zu bauen.
4. REPARATUR JETZT: Sweep über ALLE bestehenden userActions und Fremd-Owner-Actions
   aller aktiven Tasks mit dem neuen Gate (Voll-Thread-Prüfung!): Jede Action ohne
   belegbare a-c-Prüfung wird entfernt oder korrekt reklassifiziert (resolved/obsolet
   → Faktensheet-Historie mit Zitat; Fremd-Owner → owner-Name). FALL A und FALL B
   MÜSSEN dabei verschwinden — das ist das primäre Abnahmekriterium.
5. TESTS: Fixtures für die drei Fehlklassen: (i) @-Mention mit vergangenem Datum ⇒
   keine/obsolete Action; (ii) CC-only + später von Drittem beantwortet ⇒ keine Action;
   (iii) echte offene direkte Aufforderung ⇒ Action MIT askQuote. Gateway-Reject-Test
   bei fehlender Prüfspur. npm test grün.
6. TEST-SCENARIOS.md ergänzen: neue Serie C-7 (Action-Echtheit): Stichprobe JEDER
   userAction gegen den Voll-Thread (Adressierung/Auflösung/Datum) — als dauerhaftes
   Audit-Kriterium.

## Amendment 7B (Nutzer + Master, 2026-07-06 — Kern der Zusicherung, bindend)
Prompt-Disziplin allein garantiert nichts. Gründlichkeit wird BUCHFÜHRBAR gemacht:
7B-1 VERARBEITUNGS-LEDGER + CURSOR: Pro Projekt-Task persistiert der Server
     `processing: {cursorDate, threads: {<threadRef>: lastProcessedMessageDate},
     ledger: [...]}`. Jeder Scan enumeriert NEUE Items (Mails/Chat-Messages) seit
     Cursor (workiq-Abfrage nach Zeitfenster+Projekt-Bezug) und JEDES Item bekommt
     einen Ledger-Eintrag mit Pflicht-DISPOSITION:
     `{itemRef, threadRef, date, disposition: updates-node|no-change|new-node|
     conflict|not-this-project, nodeRefs[], quote, reason}` — erzeugt vom Brain auf
     Basis der VOLL-Info (Voll-Thread-Regel aus Punkt 1), validiert vom Gateway.
     QUALITÄTS-GATE im Orchestrator (deterministisch): Scan-Ergebnis wird nur
     angewandt, wenn ALLE enumerierten Items eine valide Disposition haben; fehlende
     ⇒ Job partial + Review-Hinweis. Damit ist «wurde jedes Item mit Gesamtinfo
     bedacht?» eine prüfbare Server-Tatsache, keine Modell-Behauptung.
7B-2 KNOTEN-ZUSTÄNDE: Jeder Baumknoten (factSheet-Eintrag, lineItem, Action) trägt
     `state: confirmed|disputed|superseded|obsolete`, `sources[]`,
     `lastConfirmedByMessageDate`. Marker-Grammatik/Applier entsprechend erweitern.
7B-3 KONFLIKT-HANDLING: Widerspricht ein neues Voll-Item einem bestehenden Knoten:
     NICHT überschreiben, NICHT mitteln — Knoten ⇒ `disputed` mit BEIDEN Positionen
     (je Quelle/Datum/Person, Verbatim-Zitate), Eintrag in pmStatus.problems, UI-Block
     «Conflicting information» am Projekt. Auflösung nur durch neuere autoritative
     Evidenz (Entscheider) oder Nutzer-Input (Chat/Tickbox) — dann `superseded` mit
     Begründung. Test-Fixture: zwei Threads mit gegensätzlicher Aussage ⇒ disputed-
     Knoten mit beiden Quellen, KEINE stillschweigende Wahl.
7B-4 SICHTBARKEIT: Projekt-Kopf in der UI zeigt «Processed up to <dd.mm.yyyy> ·
     <n> items considered · <m> tree updates · <k> open conflicts» aus dem Ledger.
7B-5 Ledger-Format so bauen, dass v2-Quellen (SharePoint/OneDrive-Dokumente) als
     weitere itemRef-Typen durch DASSELBE Gate laufen (nur Struktur, nicht bauen).

## Anti-Overengineering
Kein eigener Graph-Store: der «Wahrheitsbaum» IST factSheet+lineItems+threadRef-Felder.
Keine Voll-Postfach-Indizierung; Voll-Thread nur on-demand (Scope-Regel oben).

## Ablauf & Regeln
Codex: implementieren, Tests, dann Reparatur-Sweep (4) ausführen, RESULT
docs/gremium/RESULT-BATCH-7.md Zeile 1 'BATCH7: OK <actions vorher/nachher>' oder
'BATCH7: PARTIAL <grund>'. Danach Audit (agency): prüft FALL A+B am echten Bestand
(müssen weg sein), zieht 3 weitere zufällige userActions und verifiziert a-c am
Voll-Thread per workiq. Sicherheitsregeln wie immer (keine STOP/START-Skripte,
Backups, Nutzer-Instanz nicht anfassen, English-only bleibt).
