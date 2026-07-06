# P7 Abschluss-Batch (cwd = Repo-Root Agent_Zero)

Kontext: Branch feature/agency-brain, Live-Verifikation FINAL: PASS (docs/gremium/
FINAL-VERIFICATION.md, STATE.md). Aufgaben:
1. Härtung: buildAgencyEnv() in brain/agency-cli.js strippt AGENCY_SESSION_ID und
   COPILOT_AGENT_SESSION_ID aus dem Kind-Env (Session-Bleed-Schutz) + Unit-Test.
2. Doku-Sync auf Ist-Zustand (am Code verifizieren!): README.md, AGENTS.md —
   Agency-Brain-Architektur, Projekt-Tasks mit lineItems + pmStatus, Marker-Protokoll,
   Flag AGENT_ZERO_SCAN_ENGINE (Default agency, legacy-Override), WorkIQ via geerbte
   ~/.copilot/mcp-config.json statt 0.2.8-Subprozess, brain-work-Sandbox.
   CHANGELOG-Abschnitt (v5.0.0) in README oder CHANGELOG.md. package.json → 5.0.0.
3. npm test grün halten. Kleine Commits.
4. Abschluss: docs/gremium/RESULT-P7.md, Zeile 1 'P7: OK' oder 'P7: PARTIAL <grund>'.

Sicherheitsregeln: NIEMALS STOP-AGENT-ZERO.bat/stop-agent-zero.ps1/breite Prozess-Kills
ausführen. Der Nutzer testet gerade die laufende App — keine Server starten/stoppen,
tasks.json nicht anfassen. Keine Funktionsänderungen außer Punkt 1.
