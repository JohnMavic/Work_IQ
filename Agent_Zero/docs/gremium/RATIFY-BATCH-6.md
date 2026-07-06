RATIFY: GO-WITH-CONDITIONS

# Schnellratifizierung Batch 6 — Re-Verifikations-Sweep · Owner · Erledigt-Tickbox · Task-Chat

Adversarialer Review von `PROMPT-BATCH-6.md` gegen den Ist-Code (`brain/marker-applier.js`,
`brain/reality-gateway.js`, `brain/scan-brain.js`, `brain/tasks-v5.js`, `brain/factsheet.js`,
`server.js`, `scripts/repair-circle-contamination.mjs`, `docs/AGENCY_BRAIN_SCAN_SKILL.md`).
Grundrichtung tragfähig und lean: alle vier Punkte sitzen auf bereits erprobten Schienen
(Gateway, Marker-Validator, Muster-6b-Reparaturskript mit dry-run/apply/Backup/reviewQueue,
Job-/SSE-Mechanik). Kein neuer Store, keine DB, kein zweiter Apply-Pfad, keine Zusatzzustände
über die 2-Zustand-Tickbox hinaus → kein Overengineering. Freigabe unter den Auflagen unten.
Der zentrale Schadenspfad ist C (Tickbox-Zustandslogik ist am Ist-Code lückenhaft).

## C — BLOCKIEREND: Tickbox-Persistenz gegen pmStatus-Vollersatz absichern
Ist-Befund: `applyProjectUpdate` macht `task.pmStatus = normalizePmStatus(payload.pmStatus)` —
**Vollersatz** (Skill Z.118-119: „server replaces the whole pmStatus object; missing entries
are removed"). userActions-Einträge sind `{text,date?,evidence?,confidence?}` und haben **KEINE
stabile ID**. Folge ohne Fix: ein per PATCH gesetztes `userMarkedDoneAt` wird beim nächsten Scan
durch das nächste `PROJECT_UPDATE.pmStatus` gelöscht, und „weiter beobachten/reconcilen" ist
mangels Identität unmöglich. Auflagen:
1. userActions-Einträge bekommen **stabile Identität** (explizite `id` ODER deterministischer
   Content-Key), damit PATCH EINEN Eintrag adressieren und der Reconcile „dieselbe Aktion" über
   Scans hinweg matchen kann.
2. **Server-seitiger Carry-Forward**: beim Anwenden von `PROJECT_UPDATE.pmStatus` das gespeicherte
   `userMarkedDoneAt` (und `owner`) für identitätsgleiche userActions **mergen**, NICHT dem Brain
   überlassen, es re-zuemittieren (nutzer-autorisierter Zustand darf nicht vom LLM abhängen).
3. Der Scan-State-Doc muss die als erledigt markierten userActions **+ Datum sichtbar rendern**,
   sonst kann der Brain Bestätigung/Widerspruch gar nicht beurteilen.
4. PATCH: die Ist-Allowlist (`status/notes/title/summary/enrichmentStatus/updateCheckStatus`) ist
   nur Top-Level. `userMarkedDoneAt` liegt geschachtelt in `pmStatus.userActions[]` → „bestehende
   Task-PATCH-Mechanik nutzen" heißt: Eintrag per stabiler id validieren, Flag setzen/löschen
   (Abhaken rückgängig), History-Eintrag schreiben. Keine Blind-Zuweisung an `t[field]`.
5. „Geschlossen" (Evidenz bestätigt) = History-Eintrag + Evidenz behalten, NICHT stilles Verschwinden
   (sonst Σ-Verlust). Genau zwei Übergänge, keine weiteren Regeln — wie im Prompt.

## B — Owner-Umklassifikation darf keine Aktion verlieren
Fremd-Owner-Aktion aus userActions heraus = **Move**, nicht Drop: sie MUSS als lineItem/factSheet
'Open Action' mit explizitem `owner` wieder auftauchen. Da pmStatus/userActions beim Scan
voll-ersetzt werden, geht die Aktion verloren, wenn der Brain sie nur aus userActions entfernt und
kein `LINEITEM_NEW`/Open-Action emittiert. Auflagen: (a) Reclassify per Σ-Invariante über
offene Aktionen absichern (kein Netto-Verlust vor/nach); (b) unsicherer Owner → `NEEDS_REVIEW`,
nie stiller Drop. `owner:"user"`-Ergänzung ist additiv (validatePmStatus verlangt nur `text`) — ok.

## A — Sweep-Datenverlust strukturell verhindern
1. **Reversibilität ist NICHT automatisch**: `applyProjectUpdate` ersetzt, archiviert entfernte
   Einträge nirgends. Das Sweep-Skript muss vor dem Ersetzen die entfernten pmStatus-/lineItem-
   Einträge **verbatim inkl. Evidenz-Refs in reviewQueue** ablegen (Muster 6b aus
   `repair-circle-contamination.mjs` wiederverwenden: repairId+key-Idempotenz, sourceRefs behalten).
2. **Σ-Invariante breiter messen** als nur History: pmStatus-Einträge + lineItems + sourceRefs +
   History vor/nach. sourceRefs **nicht hart löschen** (nur verschieben/entkoppeln), keine
   Dangling `evidenceRefIds`. Dry-run-Diff pro Batch (5 Tasks) inspizierbar VOR apply.
3. **Kein Gateway-Bypass**: Korrekturen laufen durch `filterMarkersThroughGateway` +
   `applyMarkerBatch` (derselbe Pfad wie Scans). Gut: der Ist-Gateway hält bei Ausfall
   PROJECT_UPDATE/pmStatus-Mutationen fail-closed auf needs-review — Sweep-Korrekturen werden
   also bei Gateway-Ausfall geparkt, nicht blind angewandt. Deterministische Direkt-Entfernung nur
   für nachweislich Fabriziertes/Unreferenziertes (wie die Repair-Skripte), nie brain-getriebenes
   stilles Löschen echten Inhalts. Backup vor Mutation (writeJsonFileAtomic-Rotation, vorhanden).
4. Kosten (nicht blockierend): N Tasks × (Primär+Gateway) bei erhöhtem workiq-Budget — als
   einmaliger Datenreparaturlauf, batchweise begrenzt, vertretbar; premiumRequests weiter loggen.

## D — Task-Chat: genau EIN Apply-Pfad durch das Gateway
Prompt-Vorgabe „derselbe Validator + Reality-Gateway, kein zweiter Apply-Pfad" ist richtig.
Durchsetzen: (1) Chat-Marker MÜSSEN durch `filterMarkersThroughGateway`→`applyMarkerBatch` — der
heutige `runLogJob` schreibt per SDK-JSON **am Gateway vorbei** direkt in die Task; dieser
Nicht-Gateway-Apply muss ersetzt/legacy-gated werden, nicht danebenstehen bleiben. (2) `applyMarkerBatch`
mit der VOLLEN tasks.json speisen (buildSourceRefIndex über alle Tasks), damit `evidenceRefIds`
auflösen; Brain-Kontext bleibt task-scoped. (3) Der task-scoped Gateway muss die **volle
factSheet** des Tasks erhalten (RATIFY-BATCH-5 Auflage 9), sonst prüft er gegen unvollständige
Realität. (4) **Scope-Guard**: Marker aus einem task-scoped Chat, die FREMDE taskIds mutieren →
needs-review/hold (Defense-in-Depth), nicht still anwenden. (5) Leerer/ungültiger Chat-Output
mutiert nichts (Scan-Verhalten wiederverwenden). (6) In agency-Mode antwortet die Route heute 409
(guardLegacyRoute) — auf Brain-Run umverdrahten; kürzeres 10-min-Timeout ok.

## Tests (ergänzend zu den im Prompt genannten)
- C: PATCH auf nicht-existente/geschachtelte userAction-id → 400/404, kein Blind-Write; Abhaken
  rückgängig; **Regression: `userMarkedDoneAt` überlebt ein nachfolgendes PROJECT_UPDATE.pmStatus**
  (Carry-Forward-Merge greift). Reconcile: bestätigt→zu (mit Beleg+History), widersprochen→zurück
  in Aktiv-Zone mit Hinweis, markiert→nicht in Aktiv-Zone.
- B: Fremd-Owner-Aktion landet als Open Action mit owner, NICHT in userActions; Σ offene Aktionen
  vor/nach identisch; unsicher→NEEDS_REVIEW.
- A: dry-run erzeugt keinen Write; Σ-Invariante (pmStatus+lineItems+sourceRefs+history) vor apply;
  entfernter Eintrag verbatim in reviewQueue; keine Dangling-Refs.
- D: Chat-Marker durchlaufen den Gateway (Cross-Task-Marker → hold); invalider Chat-Output
  mutiert nichts.

## Fazit
Design schließt die richtigen Ursachen und bleibt lean. Blockierend ist ausschließlich C (stabile
userAction-Identität + Server-Carry-Forward gegen den pmStatus-Vollersatz + geschachteltes PATCH +
State-Doc-Sichtbarkeit); B und A/D sind mit den obigen Verlustfreiheits-/Ein-Pfad-Auflagen belastbar.
Nach deren Umsetzung: GO. Sicherheits-/Arbeitsregeln (keine STOP/START-Skripte, keine breiten Kills,
tasks.json nur via Skripte mit Backup, Nutzer-Instanz nicht anfassen, kleine Commits) gelten unverändert.
