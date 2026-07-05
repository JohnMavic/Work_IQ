P7: OK

Umgesetzt:
- `buildAgencyEnv()` entfernt `AGENCY_SESSION_ID` und `COPILOT_AGENT_SESSION_ID` aus dem Kind-Environment und setzt weiterhin das gepinnte `COPILOT_MODEL`.
- Unit-Test `tests/unit/agency-cli.mjs` ergänzt.
- `README.md` und `AGENTS.md` auf den verifizierten Agency-Brain-Ist-Zustand synchronisiert: Projekt-Tasks mit `lineItems`/`pmStatus`, Marker-Protokoll, Agency-Startmodell, legacy override, geerbte WorkIQ-MCP-Konfiguration, `brain-work/`-Sandbox.
- `docs/CHANGELOG.md` um v5.0.0 ergänzt.
- `package.json` auf `5.0.0` gesetzt. Die lokale `package-lock.json` ist per `.gitignore` ausgeschlossen und steht ebenfalls auf `5.0.0`.

Verifikation:
- `npm test` bestanden: 69/69 Tests grün.

Hinweis:
- Der Agency-Default wird durch `START-AGENT-ZERO.bat` und `Start-WorkIQ-Scan.ps1` gesetzt. Ein direkter `node server.js`-Start erbt die Umgebung unverändert; die Doku beschreibt diesen Unterschied explizit.
