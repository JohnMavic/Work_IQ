# Batch 8: Brain-Gedächtnis + Wahrheitshierarchie + Systems-of-Record

## Befund (Nutzer-Vergleich, 2026-07-07)
Gleiche Engine, zwei Welten: Die interaktive agency-Session (mit Memory, Prinzipien,
Portal-Verifikation via Edge-CDP-Pattern) beantwortete die Approval-Frage korrekt und
autoritativ; Agent Zeros Brain — amnestisch, WorkIQ-als-oberste-Wahrheit, ohne
System-of-Record-Wissen — blieb bei Mail-Signalen stehen. Root Causes: (1) kein
persistentes Brain-Gedächtnis (TZ03-learnings-Pattern wurde gestrichen), (2) falsche
Wahrheitshierarchie im Prompt, (3) Werkzeug-WISSEN fehlt (nicht Werkzeuge), (4) Chat
verschwendet Runzeit mit Grammatik-Doku-Lektüre.

## Umsetzung
1. BRAIN-LEARNINGS (TZ03-Pattern, schlank): `brain-learnings.md` im App-Root
   (englisch, kuratiert, versioniert in git). Renderer injiziert sie VOLLSTÄNDIG in
   jeden Run (Scan+Chat+Gateway; Größen-Budget beachten, bei Überschreitung älteste
   Einträge zuerst kürzen + Warnung). Brain darf Ergänzungen via neuem Marker
   `[LEARNING] {"text","category":"principle|pattern|fact","evidence"}` vorschlagen —
   Gateway prüft (allgemeingültig? kein Task-Fakt? keine Secrets?), Applier hängt an.
   SEED-INHALT (initial einchecken): (a) 'Signals vs. systems of record: notification
   emails (approvals, tickets) are SIGNALS; the authoritative state lives in the
   system (MyApprovals portal, IcM, SAP). Never assert approval/ticket STATE from
   mail alone — verify in the system or mark unverified.' (b) 'WorkIQ can
   hallucinate/omit; treat as lossy index.' (c) 'Never guess confidently; verify or
   say unverified.' (d) Edge-CDP-Portal-Check-Pattern: suche das Muster in der
   agency-Memory des Nutzers (frage agency copilot headless: 'Wo liegt dein
   Memory-File edge-cdp-automation.md? Gib den Inhalt aus') und übernimm die
   GENERISCHEN Schritte (Debug-Edge-Instanz mit eigenem Profil, WAM-SSO,
   Pending+History doppelt prüfen) als Pattern-Eintrag.
2. WAHRHEITSHIERARCHIE korrigieren (AGENCY_BRAIN_SCAN_SKILL.md + Chat-Prompt):
   Systems of Record (live geprüft) > vollständige Threads (verbatim) > WorkIQ-
   Zusammenfassungen > State-Doc > alte Summaries. Bei ZUSTANDS-Fragen (approved?
   offen? Ticket-Status?) MUSS das Brain versuchen, das System of Record zu prüfen
   (Learnings-Pattern nutzen; Shell/Tools hat es) — gelingt das nicht: Zustand
   explizit als 'unverified via system of record' kennzeichnen, NIE aus Mail-Signalen
   behaupten.
3. CHAT-BOOTSTRAP: Marker-Grammatik-Kurzreferenz + Gate-Regeln direkt in den
   Chat-Bootstrap aufnehmen (keine Doku-Lektüre zur Laufzeit); Confidence-Anzeige
   'unknown' fixen (echten Wert durchreichen).
4. INTERAKTIV-RUNS: Standard-MCP-Abspeckung für Chat lockern, wenn die Frage
   Systems-of-Record betrifft — konkret: Chat-Runs erhalten zusätzlich die agency
   Built-ins mail/graph NICHT pauschal, sondern das Brain darf bei Bedarf den
   Edge-CDP-Weg über Shell nutzen (kein neues MCP-Gerüst — Learnings-Pattern reicht).
5. ANTWORT-DISZIPLIN (Nutzer-Korrektur 2026-07-07, bindend — Chat- UND Scan-Prompt):
   a) NIEMALS mit unverifizierten Behauptungen als Fakten führen. Jede Aussage trägt
      ihren Verifikationsstatus INLINE («verified in MyApprovals portal» /
      «signal only — unverified»), nicht als Fußnote am Ende. Antwortstruktur auf
      «muss ich handeln?»: zuerst verifizierte Fakten, dann klar getrennt
      unverifizierte Kandidaten ALS Kandidaten.
   b) Bei Zustandsfragen: ERST verifizieren (System of Record, Learnings-Pattern),
      DANN antworten — der Hedge ist der Notausgang, nicht der Normalfall.
   c) Learnings-Seed ergänzen (Domänen-Fakt aus dem Portal-Check des Nutzers):
      'MyApprovals hosts two object classes: MyOrder PO approvals (PO numbers) and
      Modern Invoice approvals (GUID request ids). A task status list tracking only
      PO numbers does NOT cover invoice approvals — never infer invoice approval
      state from PO bookkeeping.'
6. Tests: Learnings-Injektion im Renderer (Budget), LEARNING-Marker-Gate,
   Hierarchie-Text in Prompts, Chat-Bootstrap enthält Grammatik. npm test grün.
Bericht docs/gremium/RESULT-BATCH-8.md Zeile 1 'BATCH8: OK' / 'BATCH8: PARTIAL <grund>'.
Sicherheitsregeln wie immer. Kleine Commits.
