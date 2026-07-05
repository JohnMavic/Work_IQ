AUDIT: GO

# AUDIT — Bestandskonsolidierung Migration (D8/A2)

Auditor: Agency Copilot (adversarial). Datum: 2026-07-05.
Rolle: read-only; es wurde ausschliesslich diese Datei geschrieben.

## Geprüftes Artefakt (Hash-gestempelt)

- Datei: `docs/gremium/migration-preview.json`
- SHA256: `F04E7F7E82E6EBC64C1C1E4D3090EC05356829CAA987C924A6AFBDD2DB9D11F8`
- mtime: `2026-07-05T13:25:18+02:00` · Grösse: 146'952 B · mode: `dry-run`
- Grundwahrheit (READ-ONLY Messlatte): `E:\Task_Zero 03\...\seestrasse-status-report.html`
  + `E:\Work_IQ\Agent_Zero\tasks.json` (v4, 76 aktive Tasks). **tasks.json nicht mutiert**
  (`dryRunMutatedTasks:false`, `tasksHashBefore==After` = `2b961ba4…`).

> **GO gilt ausschliesslich für obigen Hash.** Bei erneuter Regenerierung der Preview vor
> dem Apply ist dieses Audit ungültig → neu prüfen.

## ⚠️ Prozess-Hinweis (nicht blockierend): Preview wurde während des Audits neu generiert

Die Preview wurde um **13:25:18 mitten im Audit von Codex neu geschrieben** (v1 → v2). Der
Bericht `RESULT-CODEX-IMPL-3.md` beschreibt den **alten** Lauf (v1) und ist damit **stale**:

| Kennzahl        | RESULT-CODEX-IMPL-3 (v1) | Aktuelle Datei (v2, auditiert) |
|-----------------|--------------------------|--------------------------------|
| Projekte        | 4                        | **3** (SMARTS entfällt)        |
| Line Items      | 17                       | **18**                         |
| NEEDS_REVIEW    | 4 (+1 dropped)           | **7** (0 dropped)              |
| Archiviert      | 58                       | **56**                         |
| Unassigned      | 18                       | **20**                         |
| History After   | 801                      | 798                            |
| Links After     | 226                      | 221                            |
| Tasks After     | 80                       | 79 (76 + 3 Projekte)           |

Codex läuft zum Zeitpunkt der Verdikt-Schreibung nicht mehr; die Datei ist seit 13:25:18
über >7 min byte-stabil (90-s-Watch: 0 Änderungen). Auditiert wurde v2 (= aktueller Stand).

## Kennzahlen (verifiziert gegen tasks.json)

- 76 aktive Tasks = **56 archiviert + 20 unassigned** — Überlappung 0, verloren 0, extra 0, Duplikate 0.
- 3 Projekte / 18 Line Items / 7 NEEDS_REVIEW / 0 dropped.
- Projekte: Circle (21 sup / 5 LI), Seestrasse (31 sup / 9 LI), CAB (4 sup / 4 LI); je genau 1 Projekt pro Task (multi-assigned = 0).
- Invarianten: History 739→798 (≥), Links 106→221 (≥), Tasks 76→79, deleted = 0.
  Selbst nachgerechnet: historyBefore=739 (match), linkBefore=106 = 76 `link` + 30 `additionalLinks` (match).

---

## K1 — Seestrasse-Umbau = EIN Projekt, mit den Pflicht-Line-Items — **PASS**

Genau **ein** aktiver Projektvorschlag `ZURICH-SEESTRASSE-356` (taskId `proj-seestrasse-356`),
31 superseded Tasks, 9 Line Items. Pflichtabdeckung (Grundwahrheit-Workstreams):

- **AV/MTR-Refresh** → LI „AV decommission, install & commissioning (MTR testing)" ✓
- **LAN-Neuverkabelung** → LI „Data recabling & patch panel sourcing" + „August cabling works coordination (17–28 Aug 2026)" ✓
- **Patch-Panel/Kabelraum** → LI „Data recabling & patch panel sourcing" (Lieferzeit 6–11 Wo. als Risiko) ✓
- **CHD-Displays** → abgedeckt im Body der LIs „AV … commissioning" (`currentState`: „CHD mounting pending cabling"; `plannedNext`: „Complete CHD mounting after cabling") und „CorpNet patching & room connectivity" („blocking full MTR/CHD commissioning") + in `pmStatus` ✓ (kein eigener Titel, aber inhaltlich sauber belegt).

**Switch-Ports/WAN „wenn Evidenz":** In tasks.json existiert **kein eigenständiger** Task für
den Seestrasse-Switch `cchzurseec9401`, IcM `822105144` (0 Treffer) oder das Colt/WAN-Circuit
(0 Treffer). Der Switch `cchzurseec9401` kommt nur eingebettet im AV-Task `51bd7936` vor
(korrekt in Seestrasse). Das WAN/Single-Circuit-Thema steckt ausschliesslich im **cross-site**
Task `47f48321` („Installation planning – open questions", Circle + Seestrasse), der korrekt als
NEEDS_REVIEW/unassigned liegt. Folglich ist ein separates Switch-Port-/WAN-Line-Item aus der
tasks.json-Evidenz **nicht** ableitbar — die bedingte Anforderung ist erfüllt/nicht anwendbar.

## K2 — Genuine Fremd-Themen NICHT hineingezogen (Über-Merge-Check R5) — **PASS**

- **The Circle** (Radon 9.3E, Dual MPR 10.3D/10.3E, POs, Zones-Transition) = **eigenes** Projekt
  `ZURICH-CIRCLE-HUBLCR`, nicht in Seestrasse gemergt.
- **SMARTS Gi4/0/18 auf `cchzurz11c9402`** ist laut Quell-Task `0be21107` ein **anderes Gerät**
  („Cisco Catalyst 9410, Zurich – The Circle") als der Seestrasse-Switch `cchzurseec9401`.
  Korrekt **nicht** in Seestrasse gezogen (in v2 als 2 unassigned Single-Tasks belassen).
- **CAB** (Change Advisory Board) = eigenes Projekt.
- Cross-site/ambige Tasks `47f48321` (Installation planning), `fad27a74` (Temp-Badges Kabelraum),
  `1cd5e7b4` (Hardware/SFP-Lager Zurich-See & Circle) → **NEEDS_REVIEW**, nicht zwangs-gemergt.
- Alle 31 Seestrasse-Tasks stichprobenweise über Titel/Summary geprüft — durchgehend genuin Seestrasse.

## K3 — Kein Bestands-Task geht verloren (genau einmal zugeordnet / Single / review) — **PASS**

- Vereinigung `archivedTaskIds` (56) ∪ `unassignedTaskIds` (20) = **exakt** die 76 IDs aus tasks.json.
  Überlappung(arch∩unas)=0, fehlend=0, überzählig=0, keine Duplikate.
- `archivedTaskIds` == Vereinigung aller `supersedesTaskIds` (56, alle distinct). Kein Task von
  >1 Projekt superseded.
- Alle 7 NEEDS_REVIEW-Refs sind reale Tasks **und** in `unassignedTaskIds` enthalten (bleiben aktiv,
  nicht gelöscht). SCAN_DONE-Notes „7 review + 13 standalone = 20" stimmen exakt.

## K4 — Invarianten (Σ History/Links After ≥ Before; archiviert statt gelöscht) — **PASS**

- historySumAfter 798 ≥ 739; linkSumAfter 221 ≥ 106; taskCountAfter 79 ≥ 76; `deletedTaskIds:[]`.
- Jeder superseded Task ist von **mindestens einem Line Item** referenziert (uncovered=0) → History/Links
  gehen nicht verloren, sondern aggregieren am Projekt.
- Dry-Run non-destruktiv bestätigt (Hash before==after, `dryRunMutatedTasks:false`).
- Apply-Seite (im Skript verifiziert): `assertInvariantGate` bricht hart ab, falls eine Summe sinkt
  oder `deletedTaskIds` nicht leer ist.

## K5 — pmStatus/userActions evidenzgestützt (Stichprobe ≥5 gegen Quell-Links/Daten) — **PASS**

Alle Aussagen tragen `evidence`-Ref + `confidence:medium` (kein Overclaiming). 7 Stichproben gegen
die Quell-Tasks in tasks.json — alle exakt gedeckt (kein workiq-ask nötig, Evidenz im State vorhanden):

| # | Aussage (Projekt/Sektion) | evidence → Task | Beleg in tasks.json |
|---|---|---|---|
| 1 | risk: Patch-Panel 6–11 Wo. gefährdet August (SEE) | src-bd39f6be → `bd39f6be` | „Patch-Panel-Lieferzeit 6–11 Wochen gefährdet August-Termin" ✓ |
| 2 | problem: Zimmerberg ohne SupplierWeb, Invoice 101616080 (SEE) | src-db6dbf57 → `db6dbf57` | „kann sich nicht im … SupplierWeb-Portal anmelden" ✓ |
| 3 | userAction: Laith-Skeik-Meeting offen seit 12.06 (SEE) | src-45e5694c → `45e5694c` | Titel „meeting request UNANSWERED since 12.06." ✓ |
| 4 | planned: Cabling 17–28 Aug 2026 (SEE) | src-22907581 → `22907581` | „scheduled for 17–28 August 2026" ✓ |
| 5 | problem: 2m-Kabel zu kurz (5–15m) (SEE) | src-8012104d → `8012104d` | „2m-Kabel sind zu kurz (5–15m benötigt)" ✓ |
| 6 | risk: Lagerkosten CHF 3'578/Monat (CIRCLE) | src-61002c20 → `61002c20` | „Lagerkosten CHF 3'578/Monat" ✓ |
| 7 | userAction: 30-Jun CAB-Agenda, 3 Enterprise changes (CAB) | src-1317cde0 → `1317cde0` | „3 Enterprise changes (BOYDTON-BN1 … SANANTONIO)" ✓ |

Der kritischste Blocker der Grundwahrheit (PO/Material für Aug-Cabling, Patch-Panel-Lieferzeit) und
das zentrale Terminrisiko (17–28 Aug) sind in `problems`/`risks`/`userActions` mit Evidenz erfasst.

## K6 — Keine halluzinierten Projekte/Line Items ohne Quellbezug — **PASS**

- Alle 18 Line Items: ≥1 `evidenceRefIds` **und** ≥1 `sourceTaskIds`; 0 ohne Evidenz, 0 ohne Quelle.
- `sourceTaskIds` der Line Items (Full-UUID) ⊆ `supersedesTaskIds` ⊆ tasks.json → 0 Leaks, 0 uncovered.
- Alle 56 `sourceRefs` und alle `pmStatus`-Evidence-Refs lösen auf projekt-interne Quellen auf
  (lineItem evid-miss=0, pmStatus evid-miss=0). Alle 56 `sourceRefs.sourceTaskId` matchen **eindeutig**
  je genau einen realen Task (unresolved=0).

---

## Apply-Sicherheit (im Skript `scripts/migrate-projects-once.mjs` verifiziert)

`applyMigrationPreview` liest **`preview.markers` direkt** (kein erneuter Brain-Lauf) → dieses Audit
ist bindend für exakt diese Marker. Zusätzliche Schutzschichten beim Apply:
1. Re-Validierung jeder Preview-Marker gegen die aktuelle tasks.json; **Abbruch**, sobald eine Marker
   nicht mehr validiert (`Apply aborted: … marker(s) no longer validate`).
2. Harter Invarianten-Gate (`assertInvariantGate`) live nachgerechnet.
3. Atomarer Write (`writeJsonFileAtomic`).

## Advisories (nicht blockierend — für Codex vor/nach Apply)

1. **RESULT-CODEX-IMPL-3.md ist stale** (beschreibt v1: 4/17/58). Auf v2 (3/18/56, History→798,
   Links→221) aktualisieren, damit Bericht und Artefakt konsistent sind.
2. **`sourceRefs.sourceTaskId` sind 8-stellige Kurzform** (z.B. `7d1aa77b`), während
   `lineItems.sourceTaskIds`/`supersedesTaskIds` Full-UUID sind. Heute alle eindeutig auflösbar
   (0 Kollisionen), daher kein Korrektheitsdefekt — für robustes Folge-Matching (G4) auf Full-UUID
   normalisieren.
3. **`projectKey` in Grossbuchstaben** (`ZURICH-SEESTRASSE-356`) — kosmetisch; downstream
   case-konsistent keyen.
4. **SMARTS** wurde von Projekt (v1) zu 2 unassigned Single-Tasks (v2). Vertretbar (ein gelöster
   Einzel-Incident, keine Zwangs-Projektisierung); optionaler „Circle Network Incidents"-Grouping
   wäre eine Erweiterung, kein Fix.

## Verdikt

**AUDIT: GO** — alle 6 Kriterien PASS für Preview-Hash
`F04E7F7E82E6EBC64C1C1E4D3090EC05356829CAA987C924A6AFBDD2DB9D11F8`.
Apply nur gegen genau diesen Hash; bei Abweichung neu auditieren.
