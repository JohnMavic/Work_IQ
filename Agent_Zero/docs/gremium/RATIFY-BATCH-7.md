RATIFY: GO-WITH-CONDITIONS

# Schnellratifizierung Batch 7 — Thread-vollständige Verarbeitung + Action-Item-Gate (Wahrheitsbaum)

Adversarialer Review von `PROMPT-BATCH-7.md` gegen den Ist-Code (`brain/reality-gateway.js`,
`marker-applier.js`, `factsheet.js`, `tasks-v5.js`, Repair-Skript-Muster aus RATIFY-5/6) UND
gegen die **echte WorkIQ-Fähigkeit** — live getestet am Thread «Seestrasse - Cabling works
August». Die Diagnose (Brain synthetisiert aus lossy Schnipseln statt Volltext) trifft die
Ursache; die drei Prüfungen (Adressierung/Auflösung/Zeit) sind die richtigen. Design ist lean
(kein Graph-Store, Wahrheitsbaum = factSheet+lineItems+threadRef). Freigabe unter Auflagen; die
zentrale ist die **Abfragestrategie** — die wörtliche Prompt-Vorgabe ist empirisch falsch.

## Live-Test (entscheidend, beide Richtungen belegt)
- **Prompt-Rezept scheitert:** Abfrage «show the complete thread … all messages, dates,
  From/To/CC, full bodies» → WorkIQ meldet 24 Nachrichten / 763 Zeilen, **verweigert aber die
  verbatim-Vollausgabe** und liefert eine Zusammenfassung, die die @-Mention an Martin **komplett
  wegließ**. Genau der lossy Pfad, den Batch 7 beseitigen will — als Voll-Abruf untauglich.
- **Zielgerichteter Gate-Probe funktioniert:** Frage nach «TO vs. CC / @-Mention / später von wem
  aufgelöst / Datum» → präzise, verbatim: @-Mention 08.06 «…Du bist am Donnerstag bei der
  Ortsbegehung dabei?» (referenziertes Datum längst vergangen) **und** Martins Selbst-Antwort
  09.06 → FALL A ist nachweislich stale. Zusätzlich TO/CC-Matrix aller 24 Nachrichten mit Daten,
  plus Auflösung-durch-Dritte (Belinda 17.06). Der Gate BEKOMMT also die a-c-Evidenz — nur nicht
  über «Volltext dumpen», sondern über gezielte Fragen.

## C1 — BLOCKIEREND: Abfragestrategie umstellen (Volltext-Dump verbieten)
Ersetze in Umsetzung §1/§2 das «complete thread … full bodies»-Muster durch **gezielte
Gate-Probes pro item-tragendem Thread**: (a) «ist der Nutzer in TO oder @-Mention direkt
aufgefordert? Verbatim-Satz + Absender + Datum», (b) «wurde diese Bitte SPÄTER beantwortet/erledigt
— von wem, Verbatim + Datum?», (c) «liegen referenzierte Termine in der Vergangenheit?». Der
Volltext-Verbatim-Abruf ist als Pflicht untauglich (self-truncation) — nicht darauf bauen. Budget
Soft20/Hard40 hält **nur** unter Ziel-Probes (~1–2/Thread); ein Chunk-Reconstruct von 763 Zeilen
(3+ Abfragen/Thread) sprengt es → Chunk-Rekonstruktion nicht zum Normalpfad machen.

## C2 — BLOCKIEREND: threadRef auf stabilen Konversations-Anker, NICHT Betreff
`threadRef` muss auf der **stabilen conversationId/ItemID** ankern, die WorkIQ zurückgibt, nicht
auf dem Betreff-String. Betreffzeilen mutieren (Re:/AW:/`[EXTERNAL]`/Rename) — ein Betreff-Key
erzeugt genau die Parallel-Wahrheiten, die der Batch verhindern will. Betreff nur als Anzeige-Label.

## C3 — BLOCKIEREND: Auflösungs-Check evidenz-symmetrisch (gegen falsche Unterdrückung)
Der Gate unterdrückt jetzt Actions auf WorkIQ-Aussage hin — WorkIQ ist selbst ein LLM über Retrieval.
Um eine Action als resolved/obsolet/Fremd-Owner zu **entfernen**, ist ein **Verbatim-Auflösungs-Zitat
+ Autor + Datum** Pflicht (`resolvedBy{text,from,date}`). Ohne Verbatim-Beleg: **kein stiller Drop** →
Eintrag bleibt offen ODER `NEEDS_REVIEW`. Sonst kippt ein WorkIQ-Fehl-«resolved» eine echte Aufgabe.

## C4 — BLOCKIEREND: Unsicherheit ⇒ fail-safe zu NEEDS_REVIEW beim ERZEUGEN
Gate-Probe muss Nachrichtenzahl + Datum der letzten Nachricht ausweisen; ist die Abdeckung unsicher
oder ist die letzte Thread-Nachricht neuer als das Geprüfte, wird **keine** userAction auto-emittiert
(HOLD/NEEDS_REVIEW). Eine falsche Nutzer-Aufgabe ist genau der zu tilgende Schaden → bei Unsicherheit
Richtung Unterdrückung kippen, nicht Richtung Aktion.

## Nicht-blockierende Auflagen
- **Kollektiv-Adressierung** («ihr/you all», Martin einer von mehreren in TO, z.B. 16.06 18:32): nicht
  automatisch Martin-owned. Nur bei eindeutiger Alleinverantwortung ODER unaufgelöst-und-unbeansprucht;
  sonst `NEEDS_REVIEW`. WorkIQ trennt «Statement über Martin» sauber von «Bitte an Martin» — im
  Skill/Gateway-Prompt gleich fordern.
- **askQuote** ist Pflicht-Evidenzobjekt `{text, from, date, threadRef=conversationId/ItemID}`; Gateway
  rejected jede userAction/Fremd-Owner-Action ohne Prüfspur (wie im Prompt). Gateway bekommt die
  Probe-Prüfspur, **nicht** die Primär-Narrative (Anchoring vermeiden — RATIFY-5 §8).
- **Reparatur-Sweep verlustfrei** = Maschinerie aus RATIFY-5/6 wiederverwenden: entfernte Actions
  verbatim + Evidenz in reviewQueue/factSheet-Historie archivieren, Σ-Invariante über offene Actions,
  Backup + atomic write, **Gateway-Pfad** (kein neuer Silent-Delete). FALL A → factSheet «answered by
  Martin 09 Jun», FALL B → «resolved by Patrick Harris 09 Jun». Sweep budget-bounded, batchweise,
  resumierbar (jedes Item = ≥1 Premium-Probe). Nutzer-Instanz/STOP-START/English-only unverändert.
- **Große WorkIQ-Ausgaben** (Test-Probe = 33 KB) dürfen im Spill-Handling die To/CC-Matrix nicht
  wegtruncaten. WorkIQ-Deep-Links sind **konversations-level** (alle teilen eine ItemID) → per-Message-
  URL-Verifikation gibt es nicht; askQuote-Granularität = Text+Datum+Konversations-Ref ist akzeptiert.
- **Tests** (§5/§6): die drei Fixtures + Gateway-Reject sind richtig; ergänzen: (iv) Auflösungs-Beleg
  fehlt ⇒ Action bleibt/NEEDS_REVIEW (C3), (v) Betreff-Rename desselben Threads ⇒ Match über
  conversationId, keine Parallel-Wahrheit (C2). C-7-Audit-Serie beibehalten.

## Fazit
Kernannahme des Batches ist am Echtbestand **validiert** — WorkIQ liefert die a-c-Fakten (verbatim,
mit Datum), FALL A/B sind so real erkennbar und tilgbar. Nur der **Beschaffungsweg** im Prompt ist
falsch (Volltext-Dump self-truncatet). Nach C1–C4 (Ziel-Probes statt Dump, conversationId-Anker,
evidenz-symmetrische Auflösung, Unsicherheit⇒HOLD) + den Verlustfreiheits-Auflagen ist das Design
belastbar: GO.

## 7B-Nachratifizierung
7B: GO-WITH-CONDITIONS

Adversarialer Re-Review NUR von Amendment 7B gegen den bestehenden Batch-7-Befund und C1–C4.
7B ist die richtige Härtung — es macht «wurde jedes Item mit Gesamtinfo bedacht?» buchführbar
statt behauptet. Aber der Kernsatz «prüfbare Server-Tatsache, keine Modell-Behauptung»
**überzieht**: das deterministische Gate beweist nur die *innere Konsistenz* des Ledgers (jedes
*enumerierte* Item hat eine wohlgeformte Disposition), NICHT die *Vollständigkeit* (dass jedes real
existierende Item auch enumeriert wurde). Damit wandert das Versteck-Problem nur eine Ebene nach
oben. Freigabe unter D1–D6; C1–C4 gelten unverändert weiter.

### D1 — Enumeration ist die eigentliche Lücke (wer garantiert die Item-Liste?)
Die Enumeration «NEUE Items seit Cursor» läuft selbst über workiq (LLM+Retrieval). Ein
unvollständiger Enumerationslauf (8 von 12 Mails) passiert das Gate sauber — alle 8 haben
Dispositionen. Niemand kann 100 % Recall garantieren. Pflicht daher: (a) **separater Count-Probe
pro Thread/Fenster** («wie viele Nachrichten seit ‹Datum› in Thread X») und **Abgleich
Ledger-Count == workiq-Count**; Abweichung ⇒ Job partial + NEEDS_REVIEW, nie stiller Pass. (b) Der
Sichtbarkeits-Header (7B-4) darf «n items considered» NICHT als Existenz-Garantie ausgeben — Label
«considered (as surfaced by WorkIQ)», sonst overclaim des Recall.

### D2 — Disposal-Dispositionen sind der zweite Versteck-Kanal
`no-change` und `not-this-project` sind No-op-Ausgänge: das Brain kann ein unbequemes Item
formal-valide dorthin routen, das deterministische Orchestrator-Gate winkt es durch. Deterministik
prüft Form/Abdeckung, NICHT Korrektheit. Auflage: beide Disposal-Dispositionen tragen Pflicht-
`quote`+`reason` und werden vom **Gateway (semantisch)** mindestens so streng geprüft wie
knoten-erzeugende Dispositionen. Zwei-Gate-Modell explizit machen: Orchestrator = Vollständigkeit/
Form, Gateway = Korrektheit — das eine ersetzt das andere nicht.

### D3 — Cursor: rückdatierte / spät indizierte Mails (stärkster Einwand)
Ein sent-date-Hochwasserstand verliert spät indizierte Mails permanent (Mail vom 20.06, von WorkIQ
erst am 25.06 indiziert, Cursor stand schon auf 23.06 ⇒ nie wieder enumeriert). Auflage: Cursor
NICHT als harter sent-date-Watermark. **Overlap/Lookback-Fenster** (sent-date ≥ cursorDate − Δ, Δ
deckt Indizierungs-Lag, z.B. 7–14 T) + **itemRef-Idempotenz** (bereits verarbeitete Items
reconciliieren billig als `already-processed`/`no-change`). Cursor darf nur über Items mit
committeter valider Disposition vorrücken — **kein Advance über partial/unverarbeitete Items**
(sonst wird das Ledger selbst zum Skip-Generator). Δ (Recall-Grenze) im «Processed up to»-Header
offenlegen, damit «processed up to» ehrlich ist.

### D4 — disputed: nicht endlos, aber Flap-Loch
Auflösungspfad existiert (neuere autoritative Evidenz / Nutzer-Input ⇒ superseded) — also KEIN
Endlos-Zustand per se. Zwei Ergänzungen nötig: (a) **Anti-Flap-Monotonie**: superseded speichert
`supersededByMessageDate`; nur Konflikt-Evidenz NEUER als die Auflösung darf re-disputen — ältere
Evidenz ist per Konstruktion stale und reöffnet NICHT (sonst disputed→superseded→disputed-
Oszillation, sobald ein nachhängender Thread-Cursor die alte Position erneut liest). (b)
Nutzer-Auflösung (Chat/Tickbox) MUSS `superseded` mit Nutzer als source+date schreiben, sonst ist
«Nutzer-Input» folgenlos. Akkumulation offener disputes ist akzeptiert, solange 7B-4 sie prominent
als «k open conflicts» zählt und die Tickbox-Auflösung tatsächlich im Scope ist.

### D5 — Bindung an C1–C4 (7B erbt sie, hebt sie nicht auf)
- 7B-1 «Voll-Info» = **C1-Gate-Probe-Bündel** (Adressierung/Auflösung/Datum + Count), NICHT der
  Punkt-1-Volltext-Dump (C1: self-truncatet, untauglich). Die interne 7B-Referenz «auf Basis der
  VOLL-Info (Voll-Thread-Regel aus Punkt 1)» ist entsprechend als Ziel-Probe zu lesen, nicht als Dump.
- `threadRef` und ALLE `processing.threads`-Keys = **conversationId/ItemID** (C2). Ein Betreff-Key
  zerlegt den Per-Thread-Cursor bei Re:/AW:/`[EXTERNAL]`/Rename → Parallel-Cursor → Skips. Für 7B
  doppelt kritisch, weil hier das Cursor-Bookkeeping daran hängt.
- Knoten-Übergänge `superseded`/`obsolete` tragen Verbatim-Beleg wie C3 (kein stiller Drop;
  `resolvedBy{text,from,date}` bzw. Datums-Evidenz für obsolet).
- Enumerations- und Cursor-Unsicherheit ⇒ partial/NEEDS_REVIEW (C4-Analog auf Ledger-Ebene) —
  fail-safe Richtung Unterdrückung, nicht Richtung Aktion.

### D6 — Migration (klein, aber Overclaim-Falle)
Bestehende Knoten dürfen bei Einführung von 7B-2 NICHT default `confirmed` erhalten (würde
unverifizierte Legacy-Daten als «bestätigt» waschen). Default neutral (`unconfirmed` /
`lastConfirmedByMessageDate=null`), bis echte Evidenz sie bestätigt.

### Fazit 7B
Richtige, buchführbare Härtung der bestehenden Auflagen — aber das deterministische Gate ist ein
Konsistenz-, kein Vollständigkeitsbeweis. Die realen Löcher sitzen in der Enumeration (D1), den
Disposal-Dispositionen (D2) und dem Cursor-Late-Arrival (D3), plus dem disputed-Flap (D4). Alle
sind deterministisch bzw. per Count-Probe / Overlap-Fenster / Gateway-Scrutiny schließbar. Mit
D1–D6 und unverändert geltenden C1–C4: GO.
