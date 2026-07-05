FIXLINKS: OK 53/0

# Evidence-/Source-Link Hotfix

## Code-Fixes

- A Renderer: bestehende `sourceRefs` werden im Scan-State nur noch mit `srcId`,
  Titel, Datum und Absender gerendert. Bestehende Links werden nicht mehr gekuerzt
  oder in das State-Doc geschrieben. Der Agency-Brain-Prompt verlangt jetzt:
  bestehende Quellen per `srcId` referenzieren; neue WorkIQ-Quellen nur mit vollem
  `http(s)://` Link liefern; Links nie abkuerzen oder rekonstruieren.
- B Applier: eingefuehrte `sourceRef.link` Werte werden sanitisiert. Nicht-http
  Links oder Links mit `...` werden auf `null` gesetzt, auditiert und droppen den
  Marker nicht.
- C UI: Evidence-Badges loesen `srcId` oder Legacy-URL gegen `task.sourceRefs` auf.
  Ohne validen aufloesbaren Link wird `Quelle fehlt` angezeigt. Die Detailansicht
  zeigt eine sortierte Quellenliste mit Titel, Datum und Absender; Listen mit mehr
  als 8 Quellen sind einklappbar.

## Daten-Reparatur

- Dry-run 1: 52 Issues, 52 repariert, 0 unresolved.
- Apply 1: 52 SourceRefs in 3 Projekten repariert.
- Dry-run 2: 1 neu sichtbar gewordener Duplikat-Link-Fix, 1 repariert, 0 unresolved.
- Apply 2: `src-zones-aug-1783` repariert.
- Finaler Dry-run: 0 Issues, 0 repariert, 0 unresolved.
- Backup-Rotation durch `writeJsonFileAtomic`: aktuelle Sicherung `tasks.json.1.bak`.

Validierung nach Apply:

- corrupt sourceRef links: 0
- missing sourceRef links: 0
- non-http sourceRef links: 0
- verbleibende Duplikatgruppen: valide Voll-Links, vom Repair-Skript gegen
  archivierte Quelltasks als legitime gleiche Thread-/Message-Links verifiziert.

## Tests

- `npm test`: 73/73 bestanden.
